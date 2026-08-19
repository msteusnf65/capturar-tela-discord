let cameraStream = null;

export async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Este navegador não permite acesso à câmera.');
  }

  cameraStream = await navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      facingMode: 'user',
    },
    audio: false,
  });

  return cameraStream;
}

export function getCameraStream() {
  return cameraStream;
}

export function stopCamera() {
  if (!cameraStream) return;

  cameraStream.getTracks().forEach((track) => track.stop());
  cameraStream = null;
}
