# Result view-templates — not supported

The platform has a declarative JSON view-template mechanism (`resources-frontend-templates/<Type>/<subType>.view-template.json`,
served by the inherited `GET …/view-template` endpoint). **The dev-kit does not use it**: a generic field list cannot
express a resource's provisioning phases, actions beside their data, live state, logs or conditional sections, which
the detail page is expected to show. Never propose it, never vendor a renderer for it.

Every Result view is hand-written for its resource — the shell in [19-detail-page](19-detail-page.md), the content in
[17-custom-result-views](17-custom-result-views.md). The endpoint remains on the base controller for bundles that
predate the dev-kit; a new extension ships no template.
