# Third-party notices

The MCP settings and Vision Bridge portions of the built-in desktop plugin are
adapted from `7788dev/dsh-plus` commit
`2f1460289bf399dafecdd9729d639658900ad0ed`.

Copyright (c) 2026 7788dev

Licensed under the MIT License. Permission is hereby granted, free of charge,
to any person obtaining a copy of this software and associated documentation
files (the "Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, subject to inclusion of this
copyright notice and permission notice in substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

The document conversion capability is adapted from
`beancookie/dsh-plugin-anydoc` commit
`3af159ed06f62f3d2c61ab21c6a2475c71efbfa4` and uses
`@firecrawl/anydoc` version `0.1.8` from the Firecrawl anydoc project. Both are
distributed under the MIT License. The Firecrawl source reviewed for this
integration was commit `7df4b2e4213c033cfb8e94abc57ab88bb1e9b48c`.

The TA presentation card bundles `@ant-design/plots` version `2.6.5` and its
AntV rendering dependencies to provide line, bar, funnel, heatmap, and Sankey
views. The bundled Ant Design and AntV packages are distributed under the MIT
License; this includes `@ant-design/charts-util`, `@antv/g2`,
`@antv/g2-extension-plot`, `@antv/g`, `@antv/component`, the AntV canvas and
geometry packages, and their MIT-licensed utility dependencies. The applicable
MIT license text is included in `LICENSES/ant-design-plots-MIT.txt`.

Conversation image results and workspace image previews bundle
`@rc-component/image` version `1.10.0`, the image display and preview component
used by the Ant Design 6 image surface. It and its bundled React Component
dependencies are distributed under the MIT License. The applicable license
text is included in `LICENSES/rc-component-image-MIT.txt`.

The same rendering bundle includes `d3-hierarchy` version `3.1.2`, distributed
under the ISC License, and `tslib` version `2.8.1`, distributed under the 0BSD
License. Their license texts are included in `LICENSES/d3-hierarchy-ISC.txt`
and `LICENSES/tslib-0BSD.txt` respectively.

The Session Workbench Explorer, source-control, preview, and layout behavior is
adapted from `DamonKoy/dsh-web-ui`, package `dsh-aionui-panel`, commit
`3647a33fa467e0335260468614f6eed04b196c38`. The imported implementation was
modified to use Harness slots, Typert Remote services, official file
references, primitives, and theme tokens. The upstream package is distributed
under the BSD 3-Clause License; its license and attribution notice are included
in `LICENSES/dsh-aionui-panel-BSD-3-Clause.txt`.

That upstream package is itself a behavioral re-implementation of the AionUi
right-panel system (`iOfficeAI/AionUi`, version 2.1.53), which is licensed under
the Apache License, Version 2.0. No AionUi application source is vendored by
StarWeave.

The built-in web search, web fetch, provider credential-pool, and browser-based
X/Twitter and Xiaohongshu capabilities adapt source from `A3Boy/dsh-web-tools`
version `0.3.0`, commit `e664521d51c4e6fa738e79126bf2e78e2cc62455`, and integrate
it into the built-in Host and Client packages. The upstream project is
distributed under the MIT License. It was modified so updates are
delivered with StarWeave releases, browser state is kept under the desktop
private data directory, Windows browser child processes remain hidden, and the
desktop Bundle remains the sole Cordis patch owner. The license text is
included in `LICENSES/dsh-web-tools-MIT.txt`.

The host package depends on `undici` version `6.28.0` and `ws` version `8.21.0`.
Both are distributed under the MIT License; their license texts are included
in `LICENSES/undici-MIT.txt` and `LICENSES/ws-MIT.txt`.

StarWeave Design is derived from the Web implementation of OpenPencil version
`0.14.0`, commit `cb7ceea61ab1a419374f9af9bde05d033be0881f`. The Rust/Tauri
desktop, OpenPencil AI chat, model-provider, ACP, CLI, Harness, documentation,
and test applications are not included. The derived browser UI and the host's
official `@open-pencil/core` and `@open-pencil/mcp` packages are distributed
under the MIT License. The applicable license text is included in
`LICENSES/open-pencil-MIT.txt`.

The embedded StarWeave Design browser UI includes CanvasKit WASM version
`0.41.1` under the BSD 3-Clause License, Vue version `3.5.42` under the MIT
License, and Yjs version `13.6.32` under the MIT License. Their license texts
are included in `LICENSES/canvaskit-BSD-3-Clause.txt`, `LICENSES/vue-MIT.txt`,
and `LICENSES/yjs-MIT.txt` respectively.
