/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// tslint:disable:organize-imports
// tslint:disable:ban-malformed-import-paths
// tslint:dsiable:no-new-decorators

import {LitElement, css, html} from 'lit';
import {customElement, property} from 'lit/decorators.js'; // Changed this line
import {Analyser} from './analyser';

import * as THREE from 'three';
import {EXRLoader} from 'three/addons/loaders/EXRLoader.js';
import {EffectComposer} from 'three/addons/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/addons/postprocessing/RenderPass.js';
import {ShaderPass} from 'three/addons/postprocessing/ShaderPass.js';
import {UnrealBloomPass} from 'three/addons/postprocessing/UnrealBloomPass.js';
import {FXAAShader} from 'three/addons/shaders/FXAAShader.js';
import {fs as backdropFS, vs as backdropVS} from './backdrop-shader';
import {vs as sphereVS} from './sphere-shader';

/**
 * 3D live audio visual.
 */
@customElement('gdm-live-audio-visuals-3d')
export class GdmLiveAudioVisuals3D extends LitElement {
  private inputAnalyser!: Analyser;
  private outputAnalyser!: Analyser;
  private camera!: THREE.PerspectiveCamera;
  private scene!: THREE.Scene; // Added for clarity
  private renderer!: THREE.WebGLRenderer; // Added for clarity
  private backdrop!: THREE.Mesh;
  private composer!: EffectComposer;
  private sphere!: THREE.Mesh;
  private prevTime = 0;
  private rotation = new THREE.Vector3(0, 0, 0);

  private _outputNode!: AudioNode;

  @property()
  set outputNode(node: AudioNode) {
    console.log("OutputNode set");
    this._outputNode = node;
    if (this._outputNode.context) { // Ensure context is available
        this.outputAnalyser = new Analyser(this._outputNode);
    } else {
        console.error("OutputNode does not have a valid AudioContext yet.");
    }
  }

  get outputNode() {
    return this._outputNode;
  }

  private _inputNode!: AudioNode;

  @property()
  set inputNode(node: AudioNode) {
    console.log("InputNode set");
    this._inputNode = node;
    if (this._inputNode.context) { // Ensure context is available
        this.inputAnalyser = new Analyser(this._inputNode);
    } else {
        console.error("InputNode does not have a valid AudioContext yet.");
    }
  }

  get inputNode() {
    return this._inputNode;
  }

  private canvas!: HTMLCanvasElement;

  static styles = css`
    canvas {
      width: 100% !important;
      height: 100% !important;
      position: absolute;
      inset: 0;
      image-rendering: pixelated; /* Consider if this is desired for 3D */
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    console.log("gdm-live-audio-visuals-3d connected");
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    console.log("gdm-live-audio-visuals-3d disconnected");
    // Clean up Three.js resources if necessary
    window.removeEventListener('resize', this.onWindowResize); // Make sure to bind 'this' or use arrow function
    if (this.renderer) {
        this.renderer.dispose();
    }
    if (this.composer) {
        // Dispose passes if they have dispose methods
    }
    // Dispose geometries, materials, textures
  }


  private init() {
    console.log("Initializing 3D scene");
    if (!this.canvas) {
        console.error("Canvas not found during init!");
        return;
    }

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x100c14);

    this.backdrop = new THREE.Mesh(
      new THREE.IcosahedronGeometry(10, 5),
      new THREE.RawShaderMaterial({
        uniforms: {
          resolution: {value: new THREE.Vector2(1, 1)},
          rand: {value: 0},
        },
        vertexShader: backdropVS,
        fragmentShader: backdropFS,
        glslVersion: THREE.GLSL3,
      }),
    );
    this.backdrop.material.side = THREE.BackSide;
    this.scene.add(this.backdrop);
    console.log("Backdrop added to scene");

    this.camera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      0.1,
      1000,
    );
    this.camera.position.set(2, -2, 5);
    console.log("Camera initialized");

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true, // Usually true is better for 3D unless pixelated look is intentional
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio); // Typically just window.devicePixelRatio
    console.log("Renderer initialized");

    const geometry = new THREE.IcosahedronGeometry(1, 10);

    const sphereMaterial = new THREE.MeshStandardMaterial({
      color: 0x000010,
      metalness: 0.5,
      roughness: 0.1,
      emissive: 0x000010,
      emissiveIntensity: 1.5,
      name: "MainSphereMaterial" // For easier debugging in tools
    });
    console.log("Sphere material created (standard)");

    // Store reference for onBeforeCompile
    const originalOnBeforeCompile = sphereMaterial.onBeforeCompile;
    sphereMaterial.onBeforeCompile = (shader) => {
      console.log("Sphere material onBeforeCompile called");
      shader.uniforms.time = {value: 0};
      shader.uniforms.inputData = {value: new THREE.Vector4()};
      shader.uniforms.outputData = {value: new THREE.Vector4()};

      sphereMaterial.userData.shader = shader;
      shader.vertexShader = sphereVS; // Make sure sphereVS is valid GLSL
      // Call original if it existed (though for MeshStandardMaterial it's usually not set by default)
      if (originalOnBeforeCompile) originalOnBeforeCompile(shader, this.renderer);
    };

    this.sphere = new THREE.Mesh(geometry, sphereMaterial);
    this.sphere.visible = false; // Initially false, will be set true on EXR load
    this.scene.add(this.sphere);
    console.log("Sphere mesh created and added to scene (initially invisible)");


    const pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    pmremGenerator.compileEquirectangularShader();
    console.log("PMREMGenerator compiled");

    console.log("Attempting to load EXR: /piz_compressed.exr");
    new EXRLoader().load(
      '/piz_compressed.exr', // ADJUST THIS PATH if your file is not in public/piz_compressed.exr
      (texture: THREE.Texture) => {
        console.log("EXR (/piz_compressed.exr) loaded successfully!");
        texture.mapping = THREE.EquirectangularReflectionMapping;
        const exrCubeRenderTarget = pmremGenerator.fromEquirectangular(texture);
        if (sphereMaterial.envMap !== undefined) { // Check to ensure envMap property exists
            (sphereMaterial as THREE.MeshStandardMaterial).envMap = exrCubeRenderTarget.texture;
            (sphereMaterial as THREE.MeshStandardMaterial).needsUpdate = true;
            console.log("Environment map applied to sphere material.");
        } else {
            console.error("sphereMaterial does not have an envMap property (unexpected).");
        }
        this.sphere.visible = true;
        console.log("Sphere is now visible.");
        texture.dispose(); // Dispose original texture if no longer needed
        pmremGenerator.dispose(); // Dispose PMREMGenerator if one-time use
      },
      (xhr) => { // onProgress
        // console.log(`EXR loading progress: ${(xhr.loaded / xhr.total * 100)}% loaded`);
      },
      (error) => { // onError
        console.error('EXR Loading Error:', error);
        console.error('Failed to load /piz_compressed.exr. The sphere might not have its intended environment map.');
        // Fallback: Make sphere visible with a basic look if EXR fails
        this.sphere.material = new THREE.MeshBasicMaterial({ color: 0xff0000, wireframe: true });
        this.sphere.visible = true;
        console.log("Sphere made visible with fallback material due to EXR load error.");
      }
    );


    const renderPass = new RenderPass(this.scene, this.camera);

    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      5, // strength
      0.5, // radius
      0, // threshold
    );

    // const fxaaPass = new ShaderPass(FXAAShader); // FXAA can sometimes make things blurry

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(renderPass);
    // this.composer.addPass(fxaaPass);
    this.composer.addPass(bloomPass);
    console.log("Effect composer setup complete");

    // Bind onWindowResize or use arrow function to maintain 'this' context
    window.addEventListener('resize', this.onWindowResize);
    this.onWindowResize(); // Call once to set initial sizes correctly

    console.log("Starting animation loop");
    this.animation();
  }

  // Ensure onWindowResize is an arrow function or properly bound if it uses 'this'
  private onWindowResize = () => {
    if (!this.camera || !this.renderer || !this.composer || !this.backdrop ) return;

    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();

    const dPR = this.renderer.getPixelRatio();
    const w = window.innerWidth;
    const h = window.innerHeight;

    if (this.backdrop.material instanceof THREE.RawShaderMaterial) {
        this.backdrop.material.uniforms.resolution.value.set(w * dPR, h * dPR);
    }

    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);

    // If using FXAAPass, update its resolution
    // const fxaaPass = this.composer.passes.find(pass => pass instanceof ShaderPass && pass.uniforms['resolution']);
    // if (fxaaPass && (fxaaPass as ShaderPass).material.uniforms['resolution']) {
    //   (fxaaPass as ShaderPass).material.uniforms['resolution'].value.set(
    //     1 / (w * dPR),
    //     1 / (h * dPR),
    //   );
    // }
  };

  private animation() {
    requestAnimationFrame(() => this.animation());

    if (!this.inputAnalyser || !this.outputAnalyser) {
      // console.warn("Analysers not yet initialized in animation loop!");
      // Don't return here if you want the scene to render even without audio data
    } else {
        this.inputAnalyser.update();
        this.outputAnalyser.update();
    }


    const t = performance.now();
    const dt = Math.min(33, t - this.prevTime) / (1000 / 60); // Cap dt to avoid large jumps, converted to factor of 60fps frame time
    this.prevTime = t;

    const backdropMaterial = this.backdrop.material as THREE.RawShaderMaterial; // Type assertion
    const sphereMaterial = this.sphere.material as THREE.MeshStandardMaterial; // Type assertion

    if (backdropMaterial.uniforms.rand) { // Check if uniform exists
        backdropMaterial.uniforms.rand.value = Math.random() * 10000;
    }


    if (sphereMaterial.userData.shader && this.outputAnalyser && this.inputAnalyser) { // Check analysers too
      this.sphere.scale.setScalar(
        1 + (0.2 * (this.outputAnalyser.data[1] || 0)) / 255, // Use || 0 as fallback
      );

      const f = 0.001;
      this.rotation.x += (dt * f * 0.5 * (this.outputAnalyser.data[1] || 0)) / 255;
      this.rotation.z += (dt * f * 0.5 * (this.inputAnalyser.data[1] || 0)) / 255;
      this.rotation.y += (dt * f * 0.25 * (this.inputAnalyser.data[2] || 0)) / 255;
      this.rotation.y += (dt * f * 0.25 * (this.outputAnalyser.data[2] || 0)) / 255;

      const euler = new THREE.Euler(
        this.rotation.x,
        this.rotation.y,
        this.rotation.z,
      );
      const quaternion = new THREE.Quaternion().setFromEuler(euler);
      const vector = new THREE.Vector3(0, 0, 5); // Base camera distance
      vector.applyQuaternion(quaternion);
      this.camera.position.copy(vector);
      this.camera.lookAt(this.sphere.position); // Sphere is at (0,0,0)

      const shaderUniforms = sphereMaterial.userData.shader.uniforms;
      if (shaderUniforms.time) {
        shaderUniforms.time.value += (dt * 0.1 * (this.outputAnalyser.data[0] || 0)) / 255;
      }
      if (shaderUniforms.inputData) {
        shaderUniforms.inputData.value.set(
            (1 * (this.inputAnalyser.data[0] || 0)) / 255,
            (0.1 * (this.inputAnalyser.data[1] || 0)) / 255,
            (10 * (this.inputAnalyser.data[2] || 0)) / 255,
            0,
        );
      }
      if (shaderUniforms.outputData) {
        shaderUniforms.outputData.value.set(
            (2 * (this.outputAnalyser.data[0] || 0)) / 255,
            (0.1 * (this.outputAnalyser.data[1] || 0)) / 255,
            (10 * (this.outputAnalyser.data[2] || 0)) / 255,
            0,
        );
      }
    } else if (!this.outputAnalyser || !this.inputAnalyser) {
        // console.warn("Analysers not ready, sphere interaction might be static.");
    } else if (!sphereMaterial.userData.shader) {
        // console.warn("Sphere shader not compiled yet.");
    }


    if (this.composer) {
        this.composer.render();
    }
  }

  protected firstUpdated() {
    console.log("firstUpdated called");
    this.canvas = this.shadowRoot!.querySelector('canvas') as HTMLCanvasElement;
    console.log("Canvas element:", this.canvas);
    if (this.canvas) {
        this.init();
    } else {
        console.error("Canvas element not found in shadowRoot!");
    }
  }

  protected render() {
    console.log("Render method called - creating canvas tag");
    return html`<canvas></canvas>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gdm-live-audio-visuals-3d': GdmLiveAudioVisuals3D;
  }
}
