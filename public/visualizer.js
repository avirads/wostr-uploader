import * as THREE from 'three';

export class UploadVisualizer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    this.camera.position.set(0, 0, 13);

    this.clock = new THREE.Clock();
    this.tempObject = new THREE.Object3D();
    this.displayCount = 144;
    this.blockPositions = [];
    this.snapshot = {
      compressedStates: Array(this.displayCount).fill('queued'),
      progress: 0,
      completed: false
    };

    this.buildScene();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.animate = this.animate.bind(this);
    requestAnimationFrame(this.animate);
  }

  buildScene() {
    this.scene.add(new THREE.AmbientLight(0xaeddf6, 0.8));

    const keyLight = new THREE.PointLight(0x64f0da, 6, 40);
    keyLight.position.set(-5, 4, 8);
    this.scene.add(keyLight);

    const warmLight = new THREE.PointLight(0xffb85d, 4, 30);
    warmLight.position.set(6, -3, 5);
    this.scene.add(warmLight);

    this.core = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.45, 1),
      new THREE.MeshPhysicalMaterial({
        color: 0x67ffd4,
        emissive: 0x145b54,
        roughness: 0.18,
        metalness: 0.15,
        transmission: 0.25,
        thickness: 1.1,
        transparent: true,
        opacity: 0.88
      })
    );
    this.scene.add(this.core);

    this.halo = new THREE.Mesh(
      new THREE.TorusGeometry(2.8, 0.08, 24, 160),
      new THREE.MeshBasicMaterial({
        color: 0xf7a531,
        transparent: true,
        opacity: 0.75
      })
    );
    this.halo.rotation.x = 1.08;
    this.scene.add(this.halo);

    this.blocks = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.28, 0.28, 0.92),
      new THREE.MeshPhongMaterial({
        color: 0x4f6778,
        transparent: true,
        opacity: 0.95
      }),
      this.displayCount
    );
    this.blocks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this.blocks);

    for (let index = 0; index < this.displayCount; index += 1) {
      const t = this.displayCount === 1 ? 0 : index / (this.displayCount - 1);
      const angle = t * Math.PI * 9.5;
      const radius = 3 + Math.sin(t * Math.PI * 8) * 0.22;
      this.blockPositions.push(
        new THREE.Vector3((t - 0.5) * 14, Math.cos(angle) * radius, Math.sin(angle) * radius)
      );
      this.blocks.setColorAt(index, new THREE.Color(0x4f6778));
    }

    const starCount = 260;
    const starPositions = new Float32Array(starCount * 3);

    for (let index = 0; index < starCount; index += 1) {
      const radius = 10 + Math.random() * 14;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      starPositions[index * 3] = radius * Math.sin(phi) * Math.cos(theta);
      starPositions[index * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
      starPositions[index * 3 + 2] = radius * Math.cos(phi);
    }

    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    this.stars = new THREE.Points(
      starGeometry,
      new THREE.PointsMaterial({
        color: 0xdffbf3,
        size: 0.07,
        transparent: true,
        opacity: 0.65
      })
    );
    this.scene.add(this.stars);
  }

  resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  setSnapshot(snapshot) {
    this.snapshot = snapshot;
  }

  animate() {
    const elapsed = this.clock.getElapsedTime();
    const pulse = 1 + Math.sin(elapsed * 1.5) * 0.05;
    const activePulse = 1 + Math.sin(elapsed * 5.5) * 0.32;
    const completionGlow = this.snapshot.completed ? 1.35 : 1;

    this.core.rotation.x = elapsed * 0.28;
    this.core.rotation.y = elapsed * 0.62;
    this.core.scale.setScalar((0.92 + this.snapshot.progress * 0.24) * pulse * completionGlow);
    this.halo.rotation.z = elapsed * 0.16;
    this.halo.material.opacity = 0.38 + Math.min(this.snapshot.progress, 1) * 0.42;
    this.stars.rotation.y = elapsed * 0.03;
    this.stars.rotation.x = Math.sin(elapsed * 0.07) * 0.08;

    for (let index = 0; index < this.displayCount; index += 1) {
      const stateName = this.snapshot.compressedStates[index];
      const base = this.blockPositions[index];
      const wobble = Math.sin(elapsed * 1.2 + index * 0.3) * 0.08;
      const color = new THREE.Color();
      let scaleX = 1;
      let scaleY = 1;
      let scaleZ = 1;

      if (stateName === 'done') {
        color.setHex(0x6be6b8);
        scaleZ = 1.2;
      } else if (stateName === 'uploading') {
        color.setHex(0xf7a531);
        scaleX = activePulse;
        scaleY = activePulse;
        scaleZ = 1.3;
      } else if (stateName === 'error') {
        color.setHex(0xff716f);
        scaleX = 1.1 + Math.sin(elapsed * 7 + index) * 0.08;
        scaleY = scaleX;
        scaleZ = 1.15;
      } else {
        color.setHex(0x4f6778);
        scaleZ = 0.85;
      }

      this.tempObject.position.set(base.x, base.y + wobble, base.z - wobble * 0.8);
      this.tempObject.rotation.set(base.x * 0.03, elapsed * 0.2 + index * 0.04, base.y * 0.12);
      this.tempObject.scale.set(scaleX, scaleY, scaleZ);
      this.tempObject.updateMatrix();

      this.blocks.setMatrixAt(index, this.tempObject.matrix);
      this.blocks.setColorAt(index, color);
    }

    this.blocks.instanceMatrix.needsUpdate = true;

    if (this.blocks.instanceColor) {
      this.blocks.instanceColor.needsUpdate = true;
    }

    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this.animate);
  }
}

export function createVisualizer(canvas) {
  return new UploadVisualizer(canvas);
}
