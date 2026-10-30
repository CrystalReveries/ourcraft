/* 环境系统：昼夜循环 + 天气（雨） */
import * as BABYLON from "@babylonjs/core";

const DAY_SKY = BABYLON.Color3.FromHexString("#87CEEB");
const NIGHT_SKY = BABYLON.Color3.FromHexString("#1a2440");   // 夜空提亮, 保证夜间可视
const SUNSET_SKY = BABYLON.Color3.FromHexString("#f08a4b");

export type Weather = "clear" | "rain";

export class Environment {
  dayTime = 0.1;                 // 0=日出 0.25=正午 0.5=日落 0.75=午夜
  dayLength = 300;               // 一天秒数
  weather: Weather = "clear";
  private weatherTimer = 120;
  private manualWeather = false;
  private rainPS: BABYLON.ParticleSystem;
  private sun: BABYLON.DirectionalLight;
  private hemi: BABYLON.HemisphericLight;
  private scene: BABYLON.Scene;
  // 复用临时对象，避免每帧分配（GC 压力）
  private _sky = new BABYLON.Color3();
  private _out = new BABYLON.Color3();
  private _c4 = new BABYLON.Color4(0, 0, 0, 1);
  private _dir = new BABYLON.Vector3();

  constructor(scene: BABYLON.Scene, sun: BABYLON.DirectionalLight, hemi: BABYLON.HemisphericLight) {
    this.scene = scene;
    this.sun = sun;
    this.hemi = hemi;
    // 雨滴纹理
    const pt = new BABYLON.DynamicTexture("rainTex", { width: 4, height: 32 }, scene, false);
    const c = pt.getContext() as CanvasRenderingContext2D;
    c.clearRect(0, 0, 4, 32);
    c.fillStyle = "rgba(185,205,255,0.9)";
    c.fillRect(1, 0, 2, 32);
    pt.update();
    pt.hasAlpha = true;
    this.rainPS = new BABYLON.ParticleSystem("rain", 1400, scene);
    this.rainPS.particleTexture = pt;
    this.rainPS.emitter = new BABYLON.Vector3(0, 0, 0);
    this.rainPS.minEmitBox = new BABYLON.Vector3(-26, 6, -26);
    this.rainPS.maxEmitBox = new BABYLON.Vector3(26, 10, 26);
    this.rainPS.color1 = new BABYLON.Color4(0.72, 0.8, 1, 0.4);
    this.rainPS.color2 = new BABYLON.Color4(0.6, 0.72, 1, 0.35);
    this.rainPS.colorDead = new BABYLON.Color4(0.6, 0.72, 1, 0.05);
    this.rainPS.minSize = 0.25;
    this.rainPS.maxSize = 0.45;
    this.rainPS.minLifeTime = 0.7;
    this.rainPS.maxLifeTime = 1.2;
    this.rainPS.emitRate = 0;
    this.rainPS.gravity = new BABYLON.Vector3(0, -42, 0);
    this.rainPS.direction1 = new BABYLON.Vector3(-1, -30, -1);
    this.rainPS.direction2 = new BABYLON.Vector3(1, -22, 1);
    this.rainPS.minEmitPower = 16;
    this.rainPS.maxEmitPower = 22;
    this.rainPS.blendMode = BABYLON.ParticleSystem.BLENDMODE_STANDARD;
    this.rainPS.start();
  }

  get isNight(): boolean {
    return Math.sin(this.dayTime * Math.PI * 2) < -0.05;
  }
  get isRaining(): boolean {
    return this.weather === "rain";
  }
  setTime(t: number): void { this.dayTime = ((t % 1) + 1) % 1; }
  setWeather(w: Weather, manual = true): void {
    this.weather = w;
    this.manualWeather = manual;
    this.weatherTimer = 180;
  }
  getTimeLabel(): string {
    const h = Math.floor(this.dayTime * 24);
    const m = Math.floor((this.dayTime * 24 - h) * 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  update(dt: number, playerPos: BABYLON.Vector3): void {
    this.dayTime = (this.dayTime + dt / this.dayLength) % 1;

    // 天气自动轮换
    if (!this.manualWeather) {
      this.weatherTimer -= dt;
      if (this.weatherTimer <= 0) {
        this.weather = Math.random() < 0.35 ? "rain" : "clear";
        this.weatherTimer = 120 + Math.random() * 120;
      }
    } else {
      this.weatherTimer -= dt;
      if (this.weatherTimer <= 0) this.manualWeather = false;
    }

    // 昼夜天色
    const f = Math.sin(this.dayTime * Math.PI * 2);
    const brightness = Math.max(0, Math.min(1, f * 2 + 0.3));
    BABYLON.Color3.LerpToRef(NIGHT_SKY, DAY_SKY, brightness, this._sky);
    const sunsetAmt = Math.max(0, 1 - Math.abs(f) * 3) * 0.55;
    BABYLON.Color3.LerpToRef(this._sky, SUNSET_SKY, sunsetAmt, this._out);
    const dim = this.weather === "rain" ? 0.55 : 1;
    this._out.scaleInPlace(dim);
    this._c4.set(this._out.r, this._out.g, this._out.b, 1);
    this.scene.clearColor = this._c4;
    this.scene.fogColor = this._out;
    // 夜间保留环境光下限, 避免全黑
    this.sun.intensity = (0.35 + 0.55 * brightness) * dim;
    this.hemi.intensity = (0.5 + 0.35 * brightness) * dim;
    const elev = Math.max(0.14, Math.abs(f) < 0.14 ? 0.14 : Math.abs(f) * (f >= 0 ? 1 : 0.3));
    this.sun.direction.copyFrom(this._dir.set(0.4, -elev, 0.3).normalize());

    // 雨
    this.rainPS.emitRate = this.weather === "rain" ? 1200 : 0;
    (this.rainPS.emitter as BABYLON.Vector3).copyFrom(playerPos);
    (this.rainPS.emitter as BABYLON.Vector3).addInPlaceFromFloats(0, 8, 0);
  }
}
