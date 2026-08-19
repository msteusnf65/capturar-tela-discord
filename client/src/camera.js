let cameraStream = null;

export async function startCamera(videoElement) {
    if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Este navegador não suporta acesso à câmera.");
    }

    cameraStream = await navigator.mediaDevices.getUserMedia({
        video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            facingMode: "user"
        },
        audio: false
    });

    videoElement.srcObject = cameraStream;
    await videoElement.play();

    return cameraStream;
}

export function stopCamera() {
    if (!cameraStream) return;

    cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
}
<video id="cameraPreview" autoplay playsinline muted></video>

<button id="startCamera">
    Ativar câmera
</button>

<button id="stopCamera">
    Desligar câmera
</button>
import { startCamera, stopCamera } from "./camera.js";

const video = document.getElementById("cameraPreview");

document.getElementById("startCamera").onclick = async () => {
    try {
        await startCamera(video);
    } catch (error) {
        console.error("Não foi possível acessar a câmera:", error);
    }
};

document.getElementById("stopCamera").onclick = () => {
    stopCamera();
};
