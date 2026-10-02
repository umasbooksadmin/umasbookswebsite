// Blog editor's Preview button (views/admin/blog.ejs). This lived in an inline
// <script>, which the app's CSP (script-src 'self') blocks.
var blogPreviewBtn = document.getElementById('blog-preview-btn');
if (blogPreviewBtn) blogPreviewBtn.addEventListener('click', function () {
  var form = document.getElementById('blog-form');
  var title = form.querySelector('[name=title]').value || 'Untitled post';
  var editor = form.querySelector('.richtext-editor');
  var content = editor ? editor.innerHTML : '';
  var win = window.open('', '_blank');
  if (!win) return;
  win.document.write(
    '<!doctype html><html><head><meta charset="utf-8"><title>Preview — ' + title.replace(/</g, '&lt;') + '</title>' +
    '<style>body{font-family:Georgia,serif;max-width:680px;margin:40px auto;padding:0 20px;line-height:1.6;color:#2a2620;} h1{font-family:Georgia,serif;}</style>' +
    '</head><body><p style="color:#999;text-transform:uppercase;font-size:12px;letter-spacing:0.06em;">Preview — not yet saved</p><h1>' + title.replace(/</g, '&lt;') + '</h1>' + content + '</body></html>'
  );
  win.document.close();
});
