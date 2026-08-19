/**
 * Pipeline de transmissão: captura → composição → codifica → envia.
 *
 * A tela pode ser transmitida sozinha ou combinada com a câmera.
 *
 * Sem WebRTC porque a Activity não tem, e sem MediaRecorder porque o container
 * impõe piso de latência. WebCodecs codifica quadro a quadro e envia direto.
 */

// H264 costuma ter encoder por hardware; VP8 quase sempre cai em software, que
// a 1080p derruba o framerate. Por isso as duas variantes de H264 vêm antes:
// annexb dispensa o blob `description`, e avcC é aceito onde annexb não é.
const CANDIDATES = [
  { codec: 'avc1.42E01E', avc: { format: 'annexb' } },
  { codec: 'avc1.42E01E' },
  { codec: 'vp8' },
  { codec: 'vp09.00.10.08' },
];

// Keyframe periódico: seguro barato para quem reconecta fora do fluxo normal.
const KEYFRAME_EVERY_MS = 3000;

// Tipos do primeiro byte útil de cada pacote.
const TIPO_KEYFRAME = 1;
const TIPO_DELTA = 2;
const TIPO_AUDIO = 3;

// 96 kbps em Opus estéreo.
const AUDIO_BITRATE = 96_000;

// Teto de resolução.
const MAX_W = 1920;
const MAX_H = 1080;

// Tamanho máximo da câmera exibida sobre a tela.
const CAMERA_W = 240;
const CAMERA_H = 135;
const CAMERA_MARGIN = 20;

const even = (n) => Math.max(2, n - (n % 2));

function fitWithin(w, h) {
  const scale = Math.min(1, MAX_W / w, MAX_H / h);

  return {
    width: even(Math.round(w * scale)),
    height: even(Math.round(h * scale)),
  };
}

/** Motivo pelo qual este navegador não consegue transmitir, ou null. */
export function supportError({ requireChromium = false } = {}) {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    return 'Este navegador não permite captura de tela. Navegador de celular não suporta captura — use um desktop.';
  }

  if (
    !window.VideoEncoder ||
    !window.VideoFrame ||
    !window.EncodedVideoChunk
  ) {
    return 'Este navegador não tem WebCodecs, necessário para transmitir. Use Chrome, Edge ou outro navegador Chromium no desktop.';
  }

  if (requireChromium && !window.MediaStreamTrackProcessor) {
    return 'Transmitir exige um navegador Chromium — Chrome, Edge, Brave ou Opera. Nos outros a captura fica com qualidade ruim, então está desabilitada. Você continua podendo assistir.';
  }

  return null;
}

/**
 * @param {object} opts
 * @param {string} opts.wsUrl
 * @param {number} opts.bitrate
 * @param {number} opts.fps
 * @param {boolean} [opts.audio]
 * @param {MediaStream|null} [opts.cameraStream]
 * @param {(info:object)=>void} [opts.onStatus]
 * @param {(stats:object)=>void} [opts.onStats]
 * @param {(reason:string)=>void} [opts.onEnd]
 * @param {(msg:string)=>void} [opts.onAviso]
 * @param {(msg:string)=>void} [opts.onError]
 */
export function createBroadcaster({
  wsUrl,
  bitrate,
  fps,
  audio = false,
  camera = false,
  cameraStream = null,
  onStatus,
  onStats,
  onEnd,
  onError,
  onAviso,
}) {
  let ws = null;
  let stream = null;
  let encoder = null;
  let reader = null;
  let audioEncoder = null;
  let audioReader = null;

  // Guarda o stream composto para podermos encerrá-lo corretamente.
  let compositeStream = null;

  let somBloqueado = false;
  let video = null;
  let config = null;
  let stage = null;
  let stageCtx = null;

  let running = false;
  let mySlot = 0;
  let wantKeyframe = true;
  let lastKeyframeAt = 0;
  let srcW = 0;
  let srcH = 0;
  let startedAt = 0;
  let bytes = 0;
  let frames = 0;
  let viewers = 0;
  let statsTimer = null;

  /**
   * Cria uma faixa de vídeo composta:
   *
   * ┌──────────────────────────────┐
   * │                              │
   * │            TELA              │
   * │                              │
   * │                    ┌──────┐  │
   * │                    │ 📷   │  │
   * │                    └──────┘  │
   * └──────────────────────────────┘
   */
  async function createCompositeTrack(screenTrack) {
    if (!cameraStream) {
      return screenTrack;
    }

    const cameraTrack = cameraStream.getVideoTracks()[0];

    if (!cameraTrack) {
      return screenTrack;
    }

    const screenVideo = document.createElement('video');
    const cameraVideo = document.createElement('video');

    screenVideo.srcObject = new MediaStream([screenTrack]);
    cameraVideo.srcObject = new MediaStream([cameraTrack]);

    screenVideo.muted = true;
    cameraVideo.muted = true;

    screenVideo.playsInline = true;
    cameraVideo.playsInline = true;

    // A câmera já deve ter sido autorizada antes de chegar aqui.
    await screenVideo.play();
    await cameraVideo.play();

    const screenSettings = screenTrack.getSettings();

    const sourceWidth = screenSettings.width || 1280;
    const sourceHeight = screenSettings.height || 720;

    const target = fitWithin(sourceWidth, sourceHeight);

    const canvas = document.createElement('canvas');

    canvas.width = target.width;
    canvas.height = target.height;

    const ctx = canvas.getContext('2d', {
      alpha: false,
      desynchronized: true,
    });

    if (!ctx) {
      throw new Error('Não foi possível criar o canvas da câmera.');
    }

    let stopped = false;

    const draw = () => {
      if (stopped) return;

      // Fundo preto caso a tela ainda não tenha um frame disponível.
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // ------------------------------- tela

      if (
        screenVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        screenVideo.videoWidth > 0 &&
        screenVideo.videoHeight > 0
      ) {
        ctx.drawImage(
          screenVideo,
          0,
          0,
          canvas.width,
          canvas.height
        );
      }

      // ------------------------------ câmera

      if (
        cameraVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        cameraVideo.videoWidth > 0 &&
        cameraVideo.videoHeight > 0
      ) {
        const cameraWidth = Math.min(
          CAMERA_W,
          canvas.width - CAMERA_MARGIN * 2
        );

        const cameraHeight = Math.min(
          CAMERA_H,
          canvas.height - CAMERA_MARGIN * 2
        );

        const x = canvas.width - cameraWidth - CAMERA_MARGIN;
        const y = canvas.height - cameraHeight - CAMERA_MARGIN;

        /*
         * Borda preta atrás da câmera.
         */
        ctx.fillStyle = '#000';
        ctx.fillRect(
          x - 4,
          y - 4,
          cameraWidth + 8,
          cameraHeight + 8
        );

        /*
         * Espelha a câmera horizontalmente.
         */
        ctx.save();

        ctx.translate(x + cameraWidth, y);
        ctx.scale(-1, 1);

        ctx.drawImage(
          cameraVideo,
          0,
          0,
          cameraWidth,
          cameraHeight
        );

        ctx.restore();
      }

      requestAnimationFrame(draw);
    };

    draw();

    /*
     * Converte o canvas em uma MediaStream.
     *
     * O restante do pipeline do projeto continua enxergando isso como
     * uma MediaStreamTrack normal.
     */
    compositeStream = canvas.captureStream(fps);

    const compositeTrack = compositeStream.getVideoTracks()[0];

    if (!compositeTrack) {
      stopped = true;
      throw new Error(
        'Não foi possível criar a transmissão composta.'
      );
    }

    compositeTrack.contentHint = 'text';

    return compositeTrack;
  }

  async function start() {
    // IMPORTANTE:
    // getDisplayMedia continua sendo chamado diretamente pelo start(),
    // preservando o gesto do usuário.
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: {
          ideal: fps,
          max: fps,
        },
      },

      // systemAudio: 'include' pede o som do computador.
      audio: audio ? audioConstraints() : false,
    });

    const screenTrack = stream.getVideoTracks()[0];

    if (!screenTrack) {
      throw new Error('Não foi possível obter a tela.');
    }

    screenTrack.contentHint = 'text';

    screenTrack.addEventListener('ended', () => {
      stop('Você parou o compartilhamento pelo navegador.');
    });

    /*
     * AQUI acontece a composição:
     *
     * sem câmera:
     *     tela → encoder
     *
     * com câmera:
     *     tela + câmera → canvas → encoder
     */
    let track;

    try {
      track = await createCompositeTrack(screenTrack);
    } catch (err) {
      console.error('[camera composite]', err);

      cleanup();

      throw new Error(
        `Não foi possível combinar a câmera com a tela: ${err.message}`
      );
    }

    /*
     * O áudio precisa consultar a faixa ORIGINAL da tela.
     *
     * Não usamos a faixa do canvas aqui porque ela não possui as propriedades
     * de displaySurface da captura original.
     */
    const audioTrack = prepararSom(screenTrack, stream);

    const s = screenTrack.getSettings();

    /*
     * Se estamos usando câmera, o tamanho real do vídeo agora vem do canvas.
     * Caso contrário, vem da tela.
     */
    const trackSettings = track.getSettings();

    const width =
      trackSettings.width ||
      s.width ||
      1280;

    const height =
      trackSettings.height ||
      s.height ||
      720;

    const target = fitWithin(width, height);

    config = await pickConfig(
      target.width,
      target.height
    );

    if (!config) {
      cleanup();
      throw new Error(
        'Nenhum codec de vídeo suportado por este navegador.'
      );
    }

    await connect();

    encoder = new VideoEncoder({
      output: onEncoded,

      error: (err) => {
        stop(`Erro no encoder: ${err.message}`);
      },
    });

    encoder.configure(config);

    ws.send(
      JSON.stringify({
        type: 'start',
      })
    );

    running = true;
    wantKeyframe = true;
    lastKeyframeAt = 0;
    srcW = 0;
    srcH = 0;
    startedAt = Date.now();

    onStatus?.({
      codec: config.codec,
      width: config.width,
      height: config.height,
      direct: Boolean(
        window.MediaStreamTrackProcessor
      ),
      camera: Boolean(cameraStream),
    });

    statsTimer = setInterval(() => {
      onStats?.({
        viewers,
        fps: frames,
        mbps: (bytes * 8) / 1e6,
        seconds: Math.floor(
          (Date.now() - startedAt) / 1000
        ),
      });

      bytes = 0;
      frames = 0;
    }, 1000);

    pump(track);

    /*
     * O áudio continua usando a faixa original da tela.
     */
    if (audioTrack) {
      pumpAudio(audioTrack);
    }

    return stream;
  }

  /**
   * Restrições da captura de som.
   */
  function audioConstraints() {
    const c = {
      systemAudio: 'include',
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    };

    if (
      navigator.mediaDevices
        .getSupportedConstraints?.()
        .restrictOwnAudio
    ) {
      c.restrictOwnAudio = true;
    }

    return c;
  }

  /**
   * Devolve a faixa de som, ou null quando ela traria a call de volta.
   */
  function prepararSom(videoTrack, capturado) {
    const faixa = capturado.getAudioTracks()[0];

    if (!faixa) {
      return null;
    }

    if (
      videoTrack
        .getSettings?.()
        .displaySurface === 'browser'
    ) {
      return faixa;
    }

    faixa.stop();

    capturado.removeTrack(faixa);

    somBloqueado = true;

    onAviso?.(
      'A tela inteira carrega o som do Discord junto, e a call se ouviria em eco. ' +
        'Transmitindo sem som — use "Som de uma aba" para escolher de onde vem o áudio.'
    );

    return null;
  }

  /**
   * Troca somente a fonte do som.
   */
  async function trocarSom() {
    const escolha =
      await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: audioConstraints(),
      });

    const faixa =
      escolha.getAudioTracks()[0];

    const superficie =
      escolha
        .getVideoTracks()[0]
        ?.getSettings?.()
        .displaySurface;

    escolha
      .getVideoTracks()
      .forEach((t) => t.stop());

    if (!faixa) {
      escolha
        .getTracks()
        .forEach((t) => t.stop());

      throw new Error(
        'Essa escolha veio sem som. Escolha uma aba e marque "Compartilhar o áudio da guia".'
      );
    }

    if (superficie !== 'browser') {
      faixa.stop();

      throw new Error(
        'Só aba tem som isolado. Tela inteira traria o Discord junto e a call se ouviria.'
      );
    }

    await audioReader?.cancel().catch(() => {});

    audioReader = null;

    if (
      audioEncoder?.state ===
      'configured'
    ) {
      try {
        audioEncoder.close();
      } catch {}
    }

    audioEncoder = null;

    somBloqueado = false;

    faixa.addEventListener(
      'ended',
      () =>
        onAviso?.(
          'A aba do som foi fechada.'
        )
    );

    pumpAudio(faixa);

    return faixa;
  }

  // -------------------------------------------------------------------- áudio

  async function pumpAudio(track) {
    if (
      !window.AudioEncoder ||
      !window.MediaStreamTrackProcessor
    ) {
      return;
    }

    const s = track.getSettings();

    const sampleRate =
      s.sampleRate || 48_000;

    const numberOfChannels =
      Math.min(
        2,
        s.channelCount || 2
      );

    try {
      audioEncoder =
        new AudioEncoder({
          output: onAudioEncoded,

          error: (err) =>
            console.warn(
              '[audio encoder]',
              err.message
            ),
        });

      audioEncoder.configure({
        codec: 'opus',
        sampleRate,
        numberOfChannels,
        bitrate: AUDIO_BITRATE,
      });
    } catch (err) {
      console.warn(
        '[audio encoder]',
        err.message
      );

      audioEncoder = null;

      return;
    }

    ws?.send(
      JSON.stringify({
        type: 'audio-config',
        config: {
          codec: 'opus',
          sampleRate,
          numberOfChannels,
        },
      })
    );

    audioReader =
      new MediaStreamTrackProcessor({
        track,
      })
        .readable
        .getReader();

    while (running) {
      let dados;

      try {
        const {
          done,
          value,
        } = await audioReader.read();

        if (done) break;

        dados = value;
      } catch {
        break;
      }

      if (
        audioEncoder?.state ===
        'configured'
      ) {
        try {
          audioEncoder.encode(dados);
        } catch (err) {
          console.warn(
            '[audio encode]',
            err.message
          );
        }
      }

      dados.close();
    }
  }

  function onAudioEncoded(chunk) {
    if (
      ws?.readyState !==
      WebSocket.OPEN
    ) {
      return;
    }

    const data = new Uint8Array(
      chunk.byteLength
    );

    chunk.copyTo(data);

    ws.send(
      empacotar(
        TIPO_AUDIO,
        chunk.timestamp ?? 0,
        data
      )
    );

    bytes +=
      18 + data.byteLength;
  }

  async function pickConfig(
    width,
    height
  ) {
    for (const realtime of [
      true,
      false,
    ]) {
      for (const candidate of CANDIDATES) {
        const cfg = {
          ...candidate,
          width,
          height,
          bitrate,
          framerate: fps,
        };

        if (realtime) {
          cfg.latencyMode =
            'realtime';
        }

        try {
          const {
            supported,
          } =
            await VideoEncoder.isConfigSupported(
              cfg
            );

          if (supported) {
            return cfg;
          }
        } catch {
          // tenta próximo codec
        }
      }
    }

    return null;
  }

  // ------------------------------------------------------------------ captura

  function pump(track) {
    if (
      window.MediaStreamTrackProcessor
    ) {
      pumpDirect(track);
    } else {
      pumpViaVideo();
    }
  }

  /** Chromium: acesso direto aos quadros. */
  async function pumpDirect(track) {
    reader =
      new MediaStreamTrackProcessor({
        track,
      })
        .readable
        .getReader();

    while (running) {
      let frame;

      try {
        const {
          done,
          value,
        } = await reader.read();

        if (done) break;

        frame = value;
      } catch {
        break;
      }

      if (!encodeFrame(frame)) {
        break;
      }
    }
  }

  /** Outros navegadores. */
  function pumpViaVideo() {
    video =
      document.createElement(
        'video'
      );

    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;

    Object.assign(
      video.style,
      {
        position: 'fixed',
        left: '-9999px',
        width: '2px',
        height: '2px',
        opacity: '0',
      }
    );

    document.body.append(video);

    video.play().catch(() => {});

    const t0 =
      performance.now();

    const hasRvfc =
      typeof video.requestVideoFrameCallback ===
      'function';

    const minGap =
      1000 / (fps + 2);

    let lastAt = 0;

    const schedule = () => {
      if (!running) return;

      if (hasRvfc) {
        video.requestVideoFrameCallback(
          tick
        );
      } else {
        requestAnimationFrame(tick);
      }
    };

    const tick = () => {
      if (!running) return;

      if (video.paused) {
        video.play().catch(() => {});
      }

      if (
        video.readyState < 2 ||
        !video.videoWidth
      ) {
        return schedule();
      }

      const now =
        performance.now();

      if (
        !hasRvfc &&
        now - lastAt < minGap
      ) {
        return schedule();
      }

      lastAt = now;

      let frame;

      try {
        frame = new VideoFrame(
          video,
          {
            timestamp:
              (now - t0) * 1000,
          }
        );
      } catch {
        return schedule();
      }

      encodeFrame(frame);

      schedule();
    };

    schedule();
  }

  function encodeFrame(frame) {
    if (
      !running ||
      encoder?.state !==
        'configured'
    ) {
      frame.close();
      return false;
    }

    /*
     * Backpressure:
     * evita acumular frames e criar latência.
     */
    if (
      encoder.encodeQueueSize > 2
    ) {
      frame.close();
      return true;
    }

    const timestamp =
      frame.timestamp ??
      performance.now() * 1000;

    syncSize(frame);

    const now = Date.now();

    if (
      now - lastKeyframeAt >
      KEYFRAME_EVERY_MS
    ) {
      wantKeyframe = true;
    }

    let out = frame;

    if (stage) {
      stageCtx.drawImage(
        frame,
        0,
        0,
        stage.width,
        stage.height
      );

      frame.close();

      out = new VideoFrame(
        stage,
        {
          timestamp,
        }
      );
    }

    try {
      encoder.encode(
        out,
        {
          keyFrame:
            wantKeyframe,
        }
      );

      if (wantKeyframe) {
        lastKeyframeAt =
          now;

        wantKeyframe = false;
      }
    } catch (err) {
      console.error(
        '[encode]',
        err
      );
    }

    out.close();

    frames++;

    return true;
  }

  function syncSize(frame) {
    const sw =
      frame.displayWidth;

    const sh =
      frame.displayHeight;

    if (
      !sw ||
      !sh ||
      (sw === srcW &&
        sh === srcH)
    ) {
      return;
    }

    srcW = sw;
    srcH = sh;

    const target =
      fitWithin(sw, sh);

    if (
      target.width !==
        config.width ||
      target.height !==
        config.height
    ) {
      config = {
        ...config,
        ...target,
      };

      encoder.configure(
        config
      );

      wantKeyframe = true;

      onStatus?.({
        codec:
          config.codec,
        width:
          config.width,
        height:
          config.height,
        direct:
          Boolean(
            window.MediaStreamTrackProcessor
          ),
        camera:
          Boolean(
            cameraStream
          ),
      });
    }

    if (
      target.width === sw &&
      target.height === sh
    ) {
      stage = null;
      stageCtx = null;
    } else {
      stage =
        document.createElement(
          'canvas'
        );

      stage.width =
        target.width;

      stage.height =
        target.height;

      stageCtx =
        stage.getContext(
          '2d',
          {
            alpha: false,
            desynchronized: true,
          }
        );
    }
  }

  function onEncoded(
    chunk,
    metadata
  ) {
    if (
      ws?.readyState !==
      WebSocket.OPEN
    ) {
      return;
    }

    if (metadata?.decoderConfig) {
      ws.send(
        JSON.stringify({
          type: 'config',
          config:
            serializeConfig(
              metadata.decoderConfig
            ),
        })
      );
    }

    const data =
      new Uint8Array(
        chunk.byteLength
      );

    chunk.copyTo(data);

    const buf = empacotar(
      chunk.type === 'key'
        ? TIPO_KEYFRAME
        : TIPO_DELTA,
      chunk.timestamp ?? 0,
      data
    );

    ws.send(buf);

    bytes +=
      buf.byteLength;
  }

  /**
   * [1B slot][1B tipo][8B timestamp][8B relógio de envio][payload]
   */
  function empacotar(
    tipo,
    timestamp,
    data
  ) {
    const buf =
      new ArrayBuffer(
        18 + data.byteLength
      );

    const view =
      new DataView(buf);

    view.setUint8(
      0,
      mySlot
    );

    view.setUint8(
      1,
      tipo
    );

    view.setFloat64(
      2,
      timestamp
    );

    view.setFloat64(
      10,
      Date.now()
    );

    new Uint8Array(
      buf,
      18
    ).set(data);

    return buf;
  }

  function serializeConfig(dc) {
    const out = {
      codec: dc.codec,
      codedWidth:
        dc.codedWidth,
      codedHeight:
        dc.codedHeight,
    };

    if (dc.description) {
      const b =
        new Uint8Array(
          dc.description instanceof
            ArrayBuffer
            ? dc.description
            : dc.description.buffer
        );

      let bin = '';

      for (const x of b) {
        bin += String.fromCharCode(
          x
        );
      }

      out.description =
        btoa(bin);
    }

    return out;
  }

  // ---------------------------------------------------------------- websocket

  function connect() {
    return new Promise(
      (resolve, reject) => {
        ws =
          new WebSocket(wsUrl);

        ws.binaryType =
          'arraybuffer';

        const timeout =
          setTimeout(() => {
            ws.close();

            reject(
              new Error(
                'Não foi possível falar com o servidor (timeout).'
              )
            );
          }, 10_000);

        ws.addEventListener(
          'open',
          () => {
            clearTimeout(
              timeout
            );

            resolve();
          }
        );

        ws.addEventListener(
          'message',
          (e) => {
            if (
              typeof e.data !==
              'string'
            ) {
              return;
            }

            const msg =
              JSON.parse(
                e.data
              );

            if (
              msg.type ===
              'slot'
            ) {
              mySlot =
                msg.slot;
            } else if (
              msg.type ===
              'state'
            ) {
              viewers =
                msg.viewers;
            } else if (
              msg.type ===
              'need-keyframe'
            ) {
              wantKeyframe =
                true;
            } else if (
              msg.type ===
              'stop-request'
            ) {
              stop(
                'Transmissão encerrada pela atividade.'
              );
            } else if (
              msg.type ===
              'error'
            ) {
              if (running) {
                stop(
                  msg.message
                );
              } else {
                clearTimeout(
                  timeout
                );

                reject(
                  new Error(
                    msg.message
                  )
                );
              }
            }
          }
        );

        ws.addEventListener(
          'error',
          () => {
            clearTimeout(
              timeout
            );

            reject(
              new Error(
                'Falha ao conectar no servidor.'
              )
            );
          }
        );

        ws.addEventListener(
          'close',
          () => {
            clearTimeout(
              timeout
            );

            if (running) {
              stop(
                'Conexão com o servidor caiu.'
              );
            }
          }
        );
      }
    );
  }

  // ------------------------------------------------------------ ao vivo

  /**
   * Troca a tela compartilhada sem derrubar a transmissão.
   *
   * A câmera continua sendo aplicada sobre a nova tela.
   */
  async function changeScreen() {
    const fresh =
      await navigator.mediaDevices.getDisplayMedia(
        {
          video: {
            frameRate: {
              ideal: fps,
              max: fps,
            },
          },
          audio: audio
            ? audioConstraints()
            : false,
        }
      );

    const previous =
      stream;

    const previousReader =
      reader;

    stream = fresh;

    const newScreenTrack =
      fresh.getVideoTracks()[0];

    if (!newScreenTrack) {
      fresh
        .getTracks()
        .forEach((t) => t.stop());

      throw new Error(
        'Não foi possível obter a nova tela.'
      );
    }

    newScreenTrack.contentHint =
      'text';

    newScreenTrack.addEventListener(
      'ended',
      () =>
        stop(
          'Você parou o compartilhamento pelo navegador.'
        )
    );

    /*
     * Para o leitor antigo antes de iniciar o novo.
     */
    reader = null;

    await previousReader
      ?.cancel()
      .catch(() => {});

    previous
      ?.getTracks()
      .forEach((t) => t.stop());

    /*
     * A câmera continua sendo aplicada.
     */
    let newTrack;

    try {
      newTrack =
        await createCompositeTrack(
          newScreenTrack
        );
    } catch (err) {
      console.error(
        '[camera composite]',
        err
      );

      fresh
        .getTracks()
        .forEach((t) => t.stop());

      throw err;
    }

    /*
     * Força atualização da resolução.
     */
    srcW = 0;
    srcH = 0;

    wantKeyframe = true;

    /*
     * Se estivermos no caminho via <video>, atualiza a fonte.
     */
    if (video) {
      video.srcObject =
        fresh;

      video
        .play()
        .catch(() => {});
    } else {
      /*
       * Chromium / MediaStreamTrackProcessor.
       */
      pumpDirect(
        newTrack
      );
    }

    /*
     * O áudio precisa continuar vindo da captura original.
     */
    await audioReader
      ?.cancel()
      .catch(() => {});

    audioReader = null;

    const novoAudio =
      prepararSom(
        newScreenTrack,
        fresh
      );

    if (novoAudio) {
      pumpAudio(
        novoAudio
      );
    }

    return fresh;
  }

  /** Ajusta qualidade e taxa de quadros com a transmissão no ar. */
  function setQuality({
    bitrate: nextBitrate,
    fps: nextFps,
  } = {}) {
    if (nextBitrate) {
      bitrate =
        nextBitrate;
    }

    if (nextFps) {
      fps =
        nextFps;
    }

    if (
      encoder?.state !==
      'configured'
    ) {
      return;
    }

    config = {
      ...config,
      bitrate,
      framerate: fps,
    };

    encoder.configure(
      config
    );

    wantKeyframe = true;

    /*
     * Ajusta a captura original.
     */
    stream
      ?.getVideoTracks()[0]
      ?.applyConstraints({
        frameRate: {
          ideal: fps,
          max: fps,
        },
      })
      .catch(() => {});
  }

  const getSettings =
    () => ({
      bitrate,
      fps,
    });

  function cleanup() {
    stream
      ?.getTracks()
      .forEach((t) =>
        t.stop()
      );

    stream = null;

    compositeStream
      ?.getTracks()
      .forEach((t) =>
        t.stop()
      );

    compositeStream = null;

    video?.remove();

    video = null;

    stage = null;
    stageCtx = null;
  }

  function stop(reason) {
    const wasRunning =
      running;

    running = false;

    clearInterval(
      statsTimer
    );

    statsTimer = null;

    reader
      ?.cancel()
      .catch(() => {});

    reader = null;

    audioReader
      ?.cancel()
      .catch(() => {});

    audioReader = null;

    for (const e of [
      encoder,
      audioEncoder,
    ]) {
      if (
        e?.state ===
        'configured'
      ) {
        try {
          e.close();
        } catch {}
      }
    }

    encoder = null;
    audioEncoder = null;

    if (
      ws?.readyState ===
      WebSocket.OPEN
    ) {
      ws.send(
        JSON.stringify({
          type: 'stop',
        })
      );

      ws.close();
    }

    ws = null;

    cleanup();

    if (wasRunning) {
      onEnd?.(
        reason ?? ''
      );
    }
  }

  return {
    start,
    stop,
    changeScreen,
    trocarSom,
    setQuality,
    getSettings,

    temSom: () =>
      Boolean(
        audioEncoder
      ),

    somBloqueado: () =>
      somBloqueado,

    isRunning: () =>
      running,
  };
}
