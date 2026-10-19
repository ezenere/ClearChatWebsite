// Painel admin do ClearChat — JS mínimo, sem dependências (CSP: script-src 'self').
// Tudo é melhoria progressiva: sem JS os formulários continuam funcionando e o servidor confere tudo.
(function () {
  'use strict'

  var $ = function (sel, root) {
    return (root || document).querySelector(sel)
  }
  var $$ = function (sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel))
  }

  // ---------------------------------------------------------------- confirmação (diálogo)
  var dialog = $('#confirm-dialog')
  var pendingForm = null

  function openConfirm(form) {
    if (!dialog || typeof dialog.showModal !== 'function') {
      return window.confirm(form.getAttribute('data-confirm'))
    }
    pendingForm = form
    $('#confirm-title', dialog).textContent = form.getAttribute('data-confirm-title') || 'Tem certeza?'
    $('#confirm-text', dialog).textContent = form.getAttribute('data-confirm') || ''
    var ok = $('#confirm-ok', dialog)
    ok.textContent = form.getAttribute('data-confirm-ok') || 'Confirmar'
    var tone = form.getAttribute('data-confirm-tone') || 'danger'
    ok.className = 'btn ' + (tone === 'danger' ? 'btn-danger' : 'btn-primary')
    $('.dlg-icon', dialog).className = 'dlg-icon' + (tone === 'danger' ? '' : ' accent')
    dialog.showModal()
    $('#confirm-cancel', dialog).focus()
    return false
  }

  if (dialog) {
    $('#confirm-cancel', dialog).addEventListener('click', function () {
      pendingForm = null
      dialog.close()
    })
    $('#confirm-ok', dialog).addEventListener('click', function () {
      var f = pendingForm
      pendingForm = null
      dialog.close()
      if (f) {
        f.setAttribute('data-confirmed', '1')
        if (typeof f.requestSubmit === 'function') f.requestSubmit()
        else f.submit()
      }
    })
  }

  document.addEventListener('submit', function (e) {
    var form = e.target
    if (!form.hasAttribute || !form.hasAttribute('data-confirm')) return
    if (form.getAttribute('data-confirmed') === '1') {
      form.removeAttribute('data-confirmed')
      return
    }
    if (!openConfirm(form)) e.preventDefault()
  })

  // ---------------------------------------------------------------- confirmação digitada (apagar conta)
  $$('[data-match]').forEach(function (input) {
    var expected = (input.getAttribute('data-match') || '').trim().toLowerCase()
    var btn = document.getElementById(input.getAttribute('data-match-target'))
    if (!btn) return
    var sync = function () {
      btn.disabled = input.value.trim().toLowerCase() !== expected
    }
    input.addEventListener('input', sync)
    sync()
  })

  // ---------------------------------------------------------------- copiar
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text)
    }
    // http na rede local não é "secure context": cai no execCommand
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.className = 'sr-only'
      document.body.appendChild(ta)
      ta.select()
      try {
        document.execCommand('copy') ? resolve() : reject(new Error('copy'))
      } catch (err) {
        reject(err)
      } finally {
        document.body.removeChild(ta)
      }
    })
  }

  $$('[data-copy]').forEach(function (btn) {
    btn.hidden = false
    btn.addEventListener('click', function () {
      var src = document.querySelector(btn.getAttribute('data-copy'))
      if (!src) return
      var label = $('.label', btn)
      var original = label ? label.textContent : ''
      copyText(src.textContent.trim()).then(
        function () {
          if (label) label.textContent = 'Copiado!'
          setTimeout(function () {
            if (label) label.textContent = original
          }, 1800)
        },
        function () {
          var range = document.createRange()
          range.selectNodeContents(src)
          var sel = window.getSelection()
          sel.removeAllRanges()
          sel.addRange(range)
          if (label) label.textContent = 'Selecionado — Ctrl+C'
        }
      )
    })
  })

  // ---------------------------------------------------------------- flash: fechar e limpar a URL
  $$('.alert [data-dismiss]').forEach(function (b) {
    b.hidden = false
    b.addEventListener('click', function () {
      b.closest('.alert').remove()
    })
  })
  if (window.history && window.history.replaceState && /[?&](ok|err)=/.test(location.search)) {
    var url = new URL(location.href)
    url.searchParams.delete('ok')
    url.searchParams.delete('err')
    history.replaceState(null, '', url.pathname + url.search + url.hash)
  }

  // ---------------------------------------------------------------- voltar (volta ao formulário, com o que foi digitado)
  $$('[data-back]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      if (window.history.length > 1) {
        e.preventDefault()
        history.back()
      }
    })
  })

  // ---------------------------------------------------------------- tabelas: linha clicável, filtro, ordenação
  $$('table.table').forEach(function (table) {
    table.classList.add('js')
    var tbody = table.tBodies[0]
    if (!tbody) return
    var rows = function () {
      return $$('tr[data-row]', tbody)
    }

    var restripe = function () {
      var i = 0
      rows().forEach(function (tr) {
        if (tr.hidden) return
        tr.classList.toggle('alt', i % 2 === 1)
        i++
      })
    }

    tbody.addEventListener('click', function (e) {
      var tr = e.target.closest('tr[data-href]')
      if (!tr || e.target.closest('a, button, input, select, label')) return
      if (e.ctrlKey || e.metaKey) window.open(tr.getAttribute('data-href'), '_blank')
      else location.href = tr.getAttribute('data-href')
    })

    // ordenação
    $$('thead th[data-sort]', table).forEach(function (th) {
      var btn = $('.th-sort', th)
      if (!btn) return
      btn.addEventListener('click', function () {
        var idx = Array.prototype.indexOf.call(th.parentNode.children, th)
        var numeric = th.getAttribute('data-sort') === 'num'
        var dir = th.getAttribute('aria-sort') === 'ascending' ? 'descending' : 'ascending'
        if (!th.hasAttribute('aria-sort') && numeric) dir = 'descending'
        $$('thead th[aria-sort]', table).forEach(function (o) {
          o.removeAttribute('aria-sort')
        })
        th.setAttribute('aria-sort', dir)
        var list = rows()
        list.sort(function (a, b) {
          var va = a.children[idx].getAttribute('data-v') || ''
          var vb = b.children[idx].getAttribute('data-v') || ''
          var r = numeric ? Number(va) - Number(vb) : va.localeCompare(vb, 'pt-BR', { sensitivity: 'base' })
          return dir === 'ascending' ? r : -r
        })
        list.forEach(function (tr) {
          tbody.appendChild(tr)
        })
        var empty = $('tr[data-empty]', tbody)
        if (empty) tbody.appendChild(empty)
        restripe()
      })
    })

    // filtro (texto + segmento)
    var filterId = table.getAttribute('data-filter')
    var input = filterId ? document.getElementById(filterId) : null
    var seg = $('[data-segment-for="' + table.id + '"]')
    var segValue = 'all'
    var empty = $('tr[data-empty]', tbody)
    var counter = $('[data-count-for="' + table.id + '"]')

    var apply = function () {
      var q = input ? input.value.trim().toLowerCase() : ''
      var shown = 0
      rows().forEach(function (tr) {
        var text = (tr.getAttribute('data-search') || tr.textContent).toLowerCase()
        var tags = ' ' + (tr.getAttribute('data-tags') || '') + ' '
        var ok = (!q || text.indexOf(q) !== -1) && (segValue === 'all' || tags.indexOf(' ' + segValue + ' ') !== -1)
        tr.hidden = !ok
        if (ok) shown++
      })
      if (empty) empty.hidden = rows().length > 0 && shown !== 0
      if (counter) counter.textContent = String(shown)
      restripe()
    }

    if (input) input.addEventListener('input', apply)
    if (seg) {
      $$('button', seg).forEach(function (b) {
        b.addEventListener('click', function () {
          $$('button', seg).forEach(function (o) {
            o.setAttribute('aria-pressed', o === b ? 'true' : 'false')
          })
          segValue = b.getAttribute('data-value') || 'all'
          apply()
        })
      })
    }
    restripe()
  })

  // ---------------------------------------------------------------- tecla "/" foca a busca
  document.addEventListener('keydown', function (e) {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return
    var t = e.target
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
    var s = $('[data-hotkey-search]')
    if (s) {
      e.preventDefault()
      s.focus()
    }
  })
})()
