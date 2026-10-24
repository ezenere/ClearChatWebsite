// Fundo do hero: uma esfera de partículas (WebGL puro, sem dependências) que respira, se afasta do
// cursor, ondula no clique e "fala" quando a chamada simulada do hero está com a voz do agente.
import { type RefObject, useEffect, useRef, useState } from 'react'
import { prefersReducedMotion } from './hooks'

const VERT = /* glsl */ `
attribute vec3 aPos;
attribute vec2 aMeta;
uniform float uTime, uAmp, uDpr, uScale, uAspect, uAlpha, uMouseOn;
uniform vec2 uMouse, uCenter;
uniform mat3 uRot;
uniform vec4 uRipple;
uniform vec3 uShock;
varying float vAlpha;
varying vec3 vColor;

vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

void main() {
  float seed = aMeta.x;
  float kind = aMeta.y;
  vec3 p = aPos;
  float n = 0.0;
  float front;
  vec3 q;
  if (kind < 0.5) {
    // esfera: ruído lento + "voz" (ruído rápido proporcional à amplitude) + onda do clique
    n = snoise(p * 1.55 + vec3(0.0, 0.0, uTime * 0.22));
    float n2 = snoise(p * 3.6 + vec3(uTime * 1.7));
    float ang = acos(clamp(dot(p, uRipple.xyz), -1.0, 1.0));
    float wave = exp(-pow((ang - uRipple.w * 2.2) * 3.0, 2.0)) * exp(-uRipple.w * 1.4);
    p *= 1.0 + 0.11 * n + uAmp * (0.06 + 0.2 * abs(n2)) + wave * 0.3;
    q = uRot * p;
  } else if (kind < 1.5) {
    // anel: gira mais rápido por dentro, treme com a voz
    float r = length(p.xz);
    float a = uTime * 0.22 / (r * r);
    p.xz = mat2(cos(a), sin(a), -sin(a), cos(a)) * p.xz;
    p.y += 0.015 * sin(uTime * 1.3 + seed * 40.0) + uAmp * 0.06 * sin(seed * 90.0 + uTime * 7.0);
    q = uRot * (mat3(1.0, 0.0, 0.0, 0.0, 0.94, 0.34, 0.0, -0.34, 0.94) * p);
  } else {
    // poeira: deriva devagar, quase sem acompanhar a rotação
    p += 0.06 * vec3(sin(uTime * 0.21 + seed * 40.0), cos(uTime * 0.17 + seed * 23.0), sin(uTime * 0.13 + seed * 11.0));
    q = p;
  }
  float d = 3.0 - q.z;
  vec2 s = q.xy * (2.4 / d) * uScale;
  vec2 clip = vec2(s.x / uAspect, s.y) + uCenter;

  // cursor: empurra para fora com um leve redemoinho
  vec2 dm = (clip - uMouse) * vec2(uAspect, 1.0);
  float L = length(dm) + 1e-4;
  float f = smoothstep(0.32, 0.0, L) * uMouseOn;
  vec2 dir = dm / L;
  vec2 push = (dir * 0.13 + vec2(-dir.y, dir.x) * 0.05) * f * f;
  // onda de choque do clique
  vec2 ds = (clip - uShock.xy) * vec2(uAspect, 1.0);
  float Ls = length(ds) + 1e-4;
  float shock = exp(-pow((Ls - uShock.z * 1.3) * 7.0, 2.0)) * exp(-uShock.z * 2.2);
  push += ds / Ls * shock * 0.09;
  clip += push / vec2(uAspect, 1.0);

  gl_Position = vec4(clip, 0.0, 1.0);

  front = clamp((q.z + 1.0) * 0.5, 0.0, 1.0);
  vec3 violet = vec3(0.55, 0.36, 0.97);
  vec3 lilac = vec3(0.80, 0.74, 1.0);
  vec3 cyan = vec3(0.45, 0.88, 1.0);
  vec3 col = mix(violet, lilac, front * 0.8);
  col = mix(col, cyan, clamp(smoothstep(0.35, 0.9, n) * 0.55 + f * 0.8 + shock * 0.6, 0.0, 1.0));
  float size;
  if (kind < 0.5) {
    vAlpha = mix(0.22, 1.0, front * front) * (0.95 + uAmp * 0.5);
    size = mix(1.8, 4.2, seed * seed) * (1.0 + uAmp * 0.5 * front);
  } else if (kind < 1.5) {
    vAlpha = mix(0.3, 0.9, front);
    size = mix(1.3, 3.0, seed * seed);
    col = mix(col, lilac, 0.4);
  } else {
    vAlpha = 0.4 * (0.6 + 0.4 * sin(uTime * (0.6 + seed * 1.5) + seed * 60.0));
    size = mix(1.0, 2.4, seed * seed);
    col = mix(lilac, cyan, step(0.85, seed));
  }
  vAlpha = (vAlpha + f * 0.7 + shock) * uAlpha;
  vColor = col;
  gl_PointSize = size * uDpr * (2.4 / d) * (1.0 + f * 0.8);
}
`

const FRAG = /* glsl */ `
precision mediump float;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c);
  if (r > 0.5) discard;
  float a = pow(1.0 - r * 2.0, 1.35) * vAlpha;
  gl_FragColor = vec4(vColor * a, a);
}
`

function buildParticles(count: number): Float32Array {
  // [x, y, z, seed, kind] por partícula
  const sphere = Math.round(count * 0.7)
  const ring = Math.round(count * 0.18)
  const dust = count - sphere - ring
  const out = new Float32Array(count * 5)
  let o = 0
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < sphere; i++) {
    const y = 1 - (i / (sphere - 1)) * 2
    const r = Math.sqrt(1 - y * y)
    const th = golden * i
    out.set([Math.cos(th) * r, y, Math.sin(th) * r, Math.random(), 0], o)
    o += 5
  }
  for (let i = 0; i < ring; i++) {
    const a = Math.random() * Math.PI * 2
    const rad = 1.45 + Math.pow(Math.random(), 1.8) * 0.75
    out.set(
      [Math.cos(a) * rad, (Math.random() - 0.5) * 0.04, Math.sin(a) * rad, Math.random(), 1],
      o
    )
    o += 5
  }
  for (let i = 0; i < dust; i++) {
    out.set(
      [
        (Math.random() - 0.5) * 7,
        (Math.random() - 0.5) * 4.2,
        (Math.random() - 0.5) * 2 - 0.5,
        Math.random(),
        2
      ],
      o
    )
    o += 5
  }
  return out
}

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type)
  if (!sh) return null
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.warn('orb shader:', gl.getShaderInfoLog(sh))
    return null
  }
  return sh
}

function rotation(ax: number, ay: number): Float32Array {
  const cx = Math.cos(ax)
  const sx = Math.sin(ax)
  const cy = Math.cos(ay)
  const sy = Math.sin(ay)
  // Rx * Ry, em coluna-maior (WebGL)
  return new Float32Array([cy, sx * sy, -cx * sy, 0, cx, sx, sy, -sx * cy, cx * cy])
}

/** Aplica a transposta (= inversa) de uma rotação coluna-maior. */
function unrotate(m: Float32Array, v: [number, number, number]): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2]
  ]
}

/**
 * `amp` (0..1) é escrito por quem simula a voz; `host` é o elemento que recebe o mouse e os
 * cliques (o hero inteiro), já que o canvas fica atrás do conteúdo.
 */
export function Orb({
  amp,
  host,
  className
}: {
  amp: RefObject<number>
  host: RefObject<HTMLElement | null>
  className?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current
    const hostEl = host.current
    if (!canvas || !hostEl) return
    const ctx = canvas.getContext('webgl', {
      alpha: true,
      antialias: false,
      premultipliedAlpha: true,
      powerPreference: 'high-performance'
    })
    if (!ctx) {
      queueMicrotask(() => setFailed(true))
      return
    }
    const gl: WebGLRenderingContext = ctx
    const vs = compile(gl, gl.VERTEX_SHADER, VERT)
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG)
    const prog = gl.createProgram()
    if (!vs || !fs || !prog) {
      queueMicrotask(() => setFailed(true))
      return
    }
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      queueMicrotask(() => setFailed(true))
      return
    }
    gl.useProgram(prog)

    const reduced = prefersReducedMotion()
    const small = Math.min(window.innerWidth, window.innerHeight) < 700
    const count = small ? 5200 : 11000
    const data = buildParticles(count)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
    const aPos = gl.getAttribLocation(prog, 'aPos')
    const aMeta = gl.getAttribLocation(prog, 'aMeta')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 20, 0)
    gl.enableVertexAttribArray(aMeta)
    gl.vertexAttribPointer(aMeta, 2, gl.FLOAT, false, 20, 12)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE)
    gl.clearColor(0, 0, 0, 0)

    const U = (name: string) => gl.getUniformLocation(prog, name)
    const u = {
      time: U('uTime'),
      amp: U('uAmp'),
      dpr: U('uDpr'),
      scale: U('uScale'),
      aspect: U('uAspect'),
      alpha: U('uAlpha'),
      mouseOn: U('uMouseOn'),
      mouse: U('uMouse'),
      center: U('uCenter'),
      rot: U('uRot'),
      ripple: U('uRipple'),
      shock: U('uShock')
    }

    let W = 1
    let H = 1
    let dpr = 1
    let scale = 0.5
    let center: [number, number] = [0, 0]
    let alpha = 1
    const resize = () => {
      const r = canvas.getBoundingClientRect()
      dpr = Math.min(window.devicePixelRatio || 1, small ? 1.5 : 1.75)
      W = Math.max(1, r.width)
      H = Math.max(1, r.height)
      canvas.width = Math.round(W * dpr)
      canvas.height = Math.round(H * dpr)
      gl.viewport(0, 0, canvas.width, canvas.height)
      const wide = W >= 1024
      // raio da esfera em pixels → escala em unidades de clip (y); 0.8 = projeção em z=0
      // largo: à direita do texto; estreito: no topo, acima do título
      const radius = wide ? Math.min(H * 0.34, W * 0.22) : Math.min(W * 0.34, 150)
      scale = radius / (H / 2) / 0.8
      center = wide ? [0.46, 0.04] : [0, 1 - (2 * (radius + 70)) / H]
      alpha = wide ? 1 : 0.85
      if (reduced) draw(performance.now())
    }

    // estado animado (suavizado no loop)
    const target = { x: 2, y: 2, on: 0 }
    const mouse = { x: 2, y: 2, on: 0 }
    let tiltX = 0
    let tiltY = 0
    let spin = 0
    let a = 0
    let rippleDir: [number, number, number] = [0, 0, 1]
    let rippleAt = -100
    let shock: [number, number] = [9, 9]
    let shockAt = -100
    let rot = rotation(0, 0)
    let last = performance.now()

    const toClip = (e: PointerEvent): [number, number] => {
      const r = canvas.getBoundingClientRect()
      return [((e.clientX - r.left) / r.width) * 2 - 1, 1 - ((e.clientY - r.top) / r.height) * 2]
    }
    const onMove = (e: PointerEvent) => {
      const [x, y] = toClip(e)
      target.x = x
      target.y = y
      target.on = e.pointerType === 'touch' ? 0.6 : 1
    }
    const onLeave = () => {
      target.on = 0
    }
    const onDown = (e: PointerEvent) => {
      const [x, y] = toClip(e)
      shock = [x, y]
      shockAt = performance.now() / 1000
      // ponto da esfera sob o cursor (se houver) → origem da ondulação
      const lx = ((x - center[0]) * (W / H)) / scale / 0.8
      const ly = (y - center[1]) / scale / 0.8
      const l2 = lx * lx + ly * ly
      if (l2 < 1.2) {
        const lz = Math.sqrt(Math.max(0, 1 - Math.min(1, l2)))
        const len = Math.hypot(lx, ly, lz) || 1
        rippleDir = unrotate(rot, [lx / len, ly / len, lz / len])
        rippleAt = shockAt
      }
    }

    let raf = 0
    let visible = true
    function draw(now: number) {
      const t = now / 1000
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const k = 1 - Math.pow(0.001, dt) // suavização independente do fps
      mouse.x += (target.x - mouse.x) * k
      mouse.y += (target.y - mouse.y) * k
      mouse.on += (target.on - mouse.on) * k * 0.6
      // inclina na direção do cursor; perto da esfera ela "escuta" (amplitude sobe um pouco)
      const tx = target.on ? (mouse.y - center[1]) * 0.35 : 0
      const ty = target.on ? (mouse.x - center[0]) * 0.45 : 0
      tiltX += (tx - tiltX) * k * 0.5
      tiltY += (ty - tiltY) * k * 0.5
      if (!reduced) spin += dt * 0.09
      rot = rotation(0.28 + tiltX, spin + tiltY)
      const near = Math.max(
        0,
        1 - Math.hypot((mouse.x - center[0]) * (W / H), mouse.y - center[1]) / (scale * 1.4)
      )
      const want = Math.max(amp.current ?? 0, near * mouse.on * 0.3)
      a += (want - a) * Math.min(1, k * 2.2)

      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.uniform1f(u.time, reduced ? 12 : t)
      gl.uniform1f(u.amp, a)
      gl.uniform1f(u.dpr, dpr)
      gl.uniform1f(u.scale, scale)
      gl.uniform1f(u.aspect, W / H)
      gl.uniform1f(u.alpha, alpha)
      gl.uniform1f(u.mouseOn, reduced ? 0 : mouse.on)
      gl.uniform2f(u.mouse, mouse.x, mouse.y)
      gl.uniform2f(u.center, center[0], center[1])
      gl.uniformMatrix3fv(u.rot, false, rot)
      gl.uniform4f(u.ripple, rippleDir[0], rippleDir[1], rippleDir[2], t - rippleAt)
      gl.uniform3f(u.shock, shock[0], shock[1], t - shockAt)
      gl.drawArrays(gl.POINTS, 0, count)
    }
    const loop = (now: number) => {
      draw(now)
      raf = visible && !document.hidden ? requestAnimationFrame(loop) : 0
    }
    const wake = () => {
      if (!raf && visible && !document.hidden && !reduced) {
        last = performance.now()
        raf = requestAnimationFrame(loop)
      }
    }

    const ro = new ResizeObserver(resize)
    ro.observe(canvas)
    resize()
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting
      wake()
    })
    io.observe(canvas)
    document.addEventListener('visibilitychange', wake)
    hostEl.addEventListener('pointermove', onMove)
    hostEl.addEventListener('pointerleave', onLeave)
    hostEl.addEventListener('pointerdown', onDown)
    const onLost = (e: Event) => {
      e.preventDefault()
      cancelAnimationFrame(raf)
      raf = 0
      setFailed(true)
    }
    canvas.addEventListener('webglcontextlost', onLost)
    if (reduced) draw(performance.now())
    else wake()

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      io.disconnect()
      document.removeEventListener('visibilitychange', wake)
      hostEl.removeEventListener('pointermove', onMove)
      hostEl.removeEventListener('pointerleave', onLeave)
      hostEl.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('webglcontextlost', onLost)
      gl.deleteBuffer(buf)
      gl.deleteProgram(prog)
      gl.deleteShader(vs)
      gl.deleteShader(fs)
    }
  }, [amp, host])

  return failed ? (
    <div aria-hidden className={className}>
      <div className="orb-fallback" />
    </div>
  ) : (
    <canvas ref={canvasRef} aria-hidden className={className} />
  )
}
