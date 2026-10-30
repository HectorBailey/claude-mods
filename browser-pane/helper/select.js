// Draws a <select>'s list inside the page. Headless Chrome opens the list as a popup window of its
// own, which the screencast never captures, so the pane showed nothing while the list sat there,
// unseen, waiting for a pick. The helper runs this in an isolated world in every page it shows: the
// page's scripts never see its variables, and its list lives in a closed shadow root that is only
// in the document while the list is open.
;(() => {
  // Once per document: the helper adds this again each time it attaches to the tab.
  if (!document.dispatchEvent(new CustomEvent('browser-pane-select', { cancelable: true }))) {
    return
  }

  document.addEventListener('browser-pane-select', event => event.preventDefault())

  const MAX_ROWS = 20
  const STYLE = `
    .list {
      position: fixed; box-sizing: border-box; overflow-y: auto; overscroll-behavior: contain;
      background: Field; color: FieldText; border: 1px solid #767676; border-radius: 2px;
      box-shadow: 0 2px 8px rgb(0 0 0 / 0.25); pointer-events: auto; user-select: none; cursor: default;
    }
    .row { padding: 1px 6px; white-space: pre; overflow: hidden; text-overflow: ellipsis; }
    .group { font-weight: bold; }
    .indented { padding-left: 18px; }
    .disabled { color: GrayText; }
    .active { background: SelectedItem; color: SelectedItemText; }
  `

  // The open list: its select, its rows (options and group labels, in order) and the highlighted row.
  let open = null

  const isPlain = select =>
    select instanceof HTMLSelectElement && !select.multiple && select.size <= 1 && !select.matches(':disabled')

  const isPickable = index => open?.rows[index]?.option !== undefined && !open.rows[index].isDisabled

  function rowsOf(select) {
    const rows = []

    for (const child of select.children) {
      if (child instanceof HTMLOptGroupElement) {
        rows.push({ label: child.label, kind: 'group' })

        for (const option of child.children) {
          if (option instanceof HTMLOptionElement && !option.hidden) {
            rows.push({ option, label: option.label, kind: 'indented', isDisabled: child.disabled || option.disabled })
          }
        }
      } else if (child instanceof HTMLOptionElement && !child.hidden) {
        rows.push({ option: child, label: child.label, kind: 'option', isDisabled: child.disabled })
      }
    }

    return rows
  }

  function highlight(index) {
    const { list, rows, active } = open
    rows[active]?.element.classList.remove('active')
    open.active = index
    const element = rows[index].element
    element.classList.add('active')

    if (element.offsetTop < list.scrollTop) {
      list.scrollTop = element.offsetTop
    } else if (element.offsetTop + element.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = element.offsetTop + element.offsetHeight - list.clientHeight
    }
  }

  // The first pickable row from `from` on, going `direction` (1 or -1), or -1 if there is none.
  function nearest(from, direction) {
    for (let index = from; index >= 0 && index < open.rows.length; index += direction) {
      if (isPickable(index)) {
        return index
      }
    }

    return -1
  }

  // Moves the highlight to the pickable row nearest `target`, looking `direction` first.
  function moveTo(target, direction) {
    const clamped = Math.max(0, Math.min(open.rows.length - 1, target))
    const index = nearest(clamped, direction) >= 0 ? nearest(clamped, direction) : nearest(clamped, -direction)

    if (index >= 0) {
      highlight(index)
    }
  }

  function show(select) {
    close()
    const rows = rowsOf(select)

    if (!rows.some(row => row.option !== undefined)) {
      return
    }

    const host = document.createElement('browser-pane-select')
    host.style.cssText =
      'all: initial !important; position: fixed !important; inset: 0 !important; ' +
      'z-index: 2147483647 !important; pointer-events: none !important;'
    const root = host.attachShadow({ mode: 'closed' })
    const style = document.createElement('style')
    style.textContent = STYLE
    const list = document.createElement('div')
    list.className = 'list'
    const font = getComputedStyle(select)
    list.style.fontFamily = font.fontFamily
    list.style.fontSize = font.fontSize
    list.style.colorScheme = font.colorScheme

    for (const row of rows) {
      row.element = document.createElement('div')
      row.element.className = ['row', row.kind, row.isDisabled ? 'disabled' : ''].join(' ')
      row.element.textContent = row.label || ' '
      list.append(row.element)
    }

    root.append(style, list)
    document.documentElement.append(host)

    // Below the select like Chrome's own list, or above it when there is more room there.
    const box = select.getBoundingClientRect()
    const wanted = Math.min(rows.length, MAX_ROWS) * rows[0].element.offsetHeight + 2
    const below = innerHeight - box.bottom
    const isAbove = wanted > below && box.top > below
    list.style.minWidth = `${box.width}px`
    list.style.maxWidth = `${innerWidth}px`
    list.style.maxHeight = `${Math.min(wanted, isAbove ? box.top : below)}px`
    list.style.left = `${Math.max(0, Math.min(box.left, innerWidth - list.offsetWidth))}px`
    list.style.top = `${isAbove ? box.top - list.offsetHeight : box.bottom}px`

    // Holding the mouse down on the list would take the keyboard from the select.
    list.addEventListener('mousedown', event => event.preventDefault())
    list.addEventListener('mousemove', event => {
      const index = rows.findIndex(row => row.element === event.target.closest('.row'))

      if (isPickable(index) && index !== open.active) {
        highlight(index)
      }
    })
    list.addEventListener('click', event => {
      const index = rows.findIndex(row => row.element === event.target.closest('.row'))

      if (isPickable(index)) {
        pick(index)
      }
    })

    open = { select, host, list, rows, active: -1 }
    select.addEventListener('blur', close)
    const selected = rows.findIndex(row => row.option?.selected)
    moveTo(isPickable(selected) ? selected : 0, 1)
  }

  function close() {
    if (open === null) {
      return
    }

    open.select.removeEventListener('blur', close)
    open.host.remove()
    open = null
  }

  function pick(index) {
    const { select, rows } = open
    const option = isPickable(index) ? rows[index].option : null
    close()

    if (option === null || option.selected) {
      return
    }

    option.selected = true
    select.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    select.dispatchEvent(new Event('change', { bubbles: true }))
  }

  addEventListener(
    'mousedown',
    event => {
      if (open !== null && event.composedPath().includes(open.host)) {
        return
      }

      const select = event.target

      if (event.button !== 0 || !isPlain(select)) {
        close()

        return
      }

      // Stops Chrome's own list opening, unseen, and takes the click for this one.
      event.preventDefault()
      select.focus({ preventScroll: true })

      if (open?.select === select) {
        close()
      } else {
        show(select)
      }
    },
    true,
  )

  addEventListener(
    'keydown',
    event => {
      if (open === null) {
        const opens =
          event.key === ' ' ||
          event.key === 'Enter' ||
          event.key === 'F4' ||
          (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp'))

        if (opens && isPlain(event.target)) {
          event.preventDefault()
          show(event.target)
        }

        return
      }

      if (event.key === 'Tab') {
        close()

        return
      }

      // While the list is open it has the keyboard, as Chrome's own does.
      event.preventDefault()
      event.stopImmediatePropagation()
      const page = Math.max(1, Math.floor(open.list.clientHeight / open.rows[0].element.offsetHeight) - 1)

      switch (event.key) {
        case 'ArrowDown':
        case 'ArrowUp': {
          const direction = event.key === 'ArrowDown' ? 1 : -1

          if (event.altKey) {
            pick(open.active)
          } else if (nearest(open.active + direction, direction) >= 0) {
            highlight(nearest(open.active + direction, direction))
          }
          break
        }
        case 'PageDown':
          moveTo(open.active + page, 1)
          break
        case 'PageUp':
          moveTo(open.active - page, -1)
          break
        case 'Home':
          moveTo(0, 1)
          break
        case 'End':
          moveTo(open.rows.length - 1, -1)
          break
        case 'Enter':
        case ' ':
          pick(open.active)
          break
        case 'Escape':
          close()
          break
      }
    },
    true,
  )

  // Chrome's own list closes when the page moves under it.
  addEventListener('scroll', close, true)
  addEventListener('resize', close)
  addEventListener('blur', close)
})()
