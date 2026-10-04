/** Original WebGL renderer for the studio's two-bone mesh subset. */
export class SpineRenderer {
  private readonly gl: WebGLRenderingContext;
  private readonly program: WebGLProgram;
  private readonly buffer: WebGLBuffer;
  private readonly indexBuffer: WebGLBuffer;
  private readonly position: number;
  private readonly uv: number;
  private readonly viewport: WebGLUniformLocation | null;
  private readonly view: WebGLUniformLocation | null;
  private readonly textures = new Map<
    string,
    { image: HTMLImageElement; texture: WebGLTexture }
  >();
  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
    });
    if (!gl)
      throw new Error(
        "WebGL is unavailable. Enable hardware acceleration to preview Spine meshes.",
      );
    this.gl = gl;
    const shader = (type: number, source: string) => {
      const result = gl.createShader(type)!;
      gl.shaderSource(result, source);
      gl.compileShader(result);
      if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(result);
        gl.deleteShader(result);
        throw new Error(message ?? "Could not compile preview shader.");
      }
      return result;
    };
    const vertex = shader(
      gl.VERTEX_SHADER,
      `attribute vec2 position; attribute vec2 uv; uniform vec2 viewport; uniform vec3 view; varying vec2 texcoord;
      void main() { vec2 pixel=vec2(position.x*view.x+view.y,view.z-position.y*view.x); gl_Position=vec4(pixel.x/viewport.x*2.0-1.0,1.0-pixel.y/viewport.y*2.0,0.0,1.0); texcoord=uv; }`,
    );
    const fragment = shader(
      gl.FRAGMENT_SHADER,
      `precision mediump float; varying vec2 texcoord; uniform sampler2D image; void main() { gl_FragColor=texture2D(image,texcoord); }`,
    );
    this.program = gl.createProgram()!;
    gl.attachShader(this.program, vertex);
    gl.attachShader(this.program, fragment);
    gl.linkProgram(this.program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS))
      throw new Error("Could not link preview shader.");
    this.buffer = gl.createBuffer()!;
    this.indexBuffer = gl.createBuffer()!;
    this.position = gl.getAttribLocation(this.program, "position");
    this.uv = gl.getAttribLocation(this.program, "uv");
    this.viewport = gl.getUniformLocation(this.program, "viewport");
    this.view = gl.getUniformLocation(this.program, "view");
  }
  begin(
    width: number,
    height: number,
    scale: number,
    cx: number,
    cy: number,
    ids: string[],
  ) {
    const gl = this.gl;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.uniform2f(this.viewport, width, height);
    gl.uniform3f(this.view, scale, cx, cy);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
    for (const [id, entry] of this.textures)
      if (!ids.includes(id)) {
        gl.deleteTexture(entry.texture);
        this.textures.delete(id);
      }
  }
  draw(
    id: string,
    image: HTMLImageElement,
    positions: number[],
    uvs: number[],
    triangles: number[],
  ) {
    const gl = this.gl;
    let entry = this.textures.get(id);
    if (!entry || entry.image !== image) {
      if (entry) gl.deleteTexture(entry.texture);
      const texture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        image,
      );
      entry = { image, texture };
      this.textures.set(id, entry);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    const data = new Float32Array(positions.length * 2);
    for (let i = 0; i < positions.length / 2; i++) {
      data[i * 4] = positions[i * 2];
      data[i * 4 + 1] = positions[i * 2 + 1];
      data[i * 4 + 2] = uvs[i * 2];
      data[i * 4 + 3] = uvs[i * 2 + 1];
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.position);
    gl.vertexAttribPointer(this.position, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(this.uv);
    gl.vertexAttribPointer(this.uv, 2, gl.FLOAT, false, 16, 8);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(
      gl.ELEMENT_ARRAY_BUFFER,
      new Uint16Array(triangles),
      gl.DYNAMIC_DRAW,
    );
    gl.drawElements(gl.TRIANGLES, triangles.length, gl.UNSIGNED_SHORT, 0);
  }
  dispose() {
    const gl = this.gl;
    for (const entry of this.textures.values()) gl.deleteTexture(entry.texture);
    this.textures.clear();
    gl.deleteProgram(this.program);
    gl.deleteBuffer(this.buffer);
    gl.deleteBuffer(this.indexBuffer);
  }
}
