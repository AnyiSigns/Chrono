// 技能页（技能身份写入入口）：列表 + 新建 / 编辑 / 启停；客户端直写技能身份 body（put + add_gen）。

import { el, textButton } from './dom.js'
import { emptyState, field, section } from './ui-parts.js'
import { isRecord } from './config-model.js'
import { listText, removeSkill, skillFromForm, skillList, toggleSkill, upsertSkill } from './settings-model.js'

export function renderSkills(ctx, content) {
  const doc = ctx.doc
  const skills = skillList(ctx.state.skillProjection)
  const list = el(doc, 'div', { class: 'settings-list' })
  if (skills.length === 0) list.appendChild(emptyState(ctx, 'settings_empty_skills', 'settings_empty_skills_hint'))
  for (const skill of skills) list.appendChild(skillRow(ctx, skill))
  content.appendChild(section(ctx, null, [list]))

  if (ctx.state.skillForm !== null) {
    content.appendChild(renderSkillForm(ctx))
    return
  }
  content.appendChild(
    section(ctx, null, [
      textButton(doc, ctx.text('settings_skills_new'), () => {
        ctx.state.skillForm = emptySkillForm()
        ctx.render()
      }),
    ]),
  )
}

function skillRow(ctx, skill) {
  const doc = ctx.doc
  const enabled = skill.enabled !== false
  const toggle = el(doc, 'input', { attrs: { type: 'checkbox' } })
  toggle.checked = enabled
  toggle.addEventListener('change', async () => {
    await ctx.writeSkillBody(toggleSkill(skillBody(ctx), skill.id, toggle.checked), `skill:${skill.id}`)
  })
  const edit = textButton(doc, ctx.text('settings_skills_edit'), () => {
    ctx.state.skillForm = {
      id: skill.id,
      name: skill.name ?? '',
      description: skill.description ?? '',
      keywords: listText(skill.triggers?.keywords),
      file_globs: listText(skill.triggers?.file_globs),
      explicit: listText(skill.triggers?.explicit),
      scope_kind: isRecord(skill.scope) && skill.scope.kind === 'workspace' ? 'workspace' : 'global',
      workspace_id: isRecord(skill.scope) && typeof skill.scope.workspace_id === 'string' ? skill.scope.workspace_id : '',
      body: skill.body ?? '',
      enabled,
    }
    ctx.render()
  })
  const remove = textButton(
    doc,
    ctx.text('settings_skills_delete'),
    async () => {
      await ctx.writeSkillBody(removeSkill(skillBody(ctx), skill.id), `skill:${skill.id}`)
    },
    { tone: 'danger' },
  )
  return el(doc, 'div', { class: 'settings-list-item', dataset: { savedKey: `skill:${skill.id}` } }, [
    el(doc, 'span', { class: 'settings-list-main', text: `${skill.name ?? skill.id} · ${skill.description ?? ''}` }),
    el(doc, 'label', { class: 'settings-check' }, [
      toggle,
      el(doc, 'span', { text: enabled ? ctx.text('settings_skills_disable') : ctx.text('settings_skills_enable') }),
    ]),
    edit,
    remove,
  ])
}

function renderSkillForm(ctx) {
  const doc = ctx.doc
  const form = ctx.state.skillForm
  const inputs = {}
  for (const key of ['name', 'description', 'keywords', 'file_globs', 'explicit']) {
    const input = el(doc, 'input', { class: 'settings-input', attrs: { type: 'text', value: form[key] } })
    input.addEventListener('input', () => {
      form[key] = input.value
    })
    inputs[key] = input
  }
  const bodyInput = el(doc, 'textarea', { class: 'settings-input', attrs: { rows: '4' } })
  bodyInput.value = form.body
  bodyInput.addEventListener('input', () => {
    form.body = bodyInput.value
  })
  const scopeSelect = el(doc, 'select', { class: 'settings-select' })
  scopeSelect.appendChild(el(doc, 'option', { text: ctx.text('settings_skills_scope_global'), attrs: { value: 'global' } }))
  scopeSelect.appendChild(
    el(doc, 'option', { text: ctx.text('settings_skills_scope_workspace'), attrs: { value: 'workspace' } }),
  )
  scopeSelect.value = form.scope_kind
  scopeSelect.addEventListener('change', () => {
    form.scope_kind = scopeSelect.value
  })
  const save = textButton(
    doc,
    ctx.text('settings_skills_save'),
    async () => {
      const id = form.id.length > 0 ? form.id : `sk-${Date.now().toString(36)}`
      const skill = skillFromForm(form, id, new Date().toISOString())
      ctx.state.skillForm = null
      await ctx.writeSkillBody(upsertSkill(skillBody(ctx), skill), `skill:${id}`)
    },
    { tone: 'accent' },
  )
  const cancel = textButton(doc, ctx.text('settings_cancel'), () => {
    ctx.state.skillForm = null
    ctx.render()
  })
  return section(ctx, null, [
    field(ctx, ctx.text('settings_skills_name'), inputs.name),
    field(ctx, ctx.text('settings_skills_description'), inputs.description),
    field(ctx, ctx.text('settings_skills_keywords'), inputs.keywords),
    field(ctx, ctx.text('settings_skills_file_globs'), inputs.file_globs),
    field(ctx, ctx.text('settings_skills_explicit'), inputs.explicit),
    field(ctx, ctx.text('settings_skills_scope'), scopeSelect),
    field(ctx, ctx.text('settings_skills_body'), bodyInput),
    el(doc, 'div', { class: 'settings-guide-actions' }, [cancel, save]),
  ])
}

function emptySkillForm() {
  return {
    id: '',
    name: '',
    description: '',
    keywords: '',
    file_globs: '',
    explicit: '',
    scope_kind: 'global',
    workspace_id: '',
    body: '',
    enabled: true,
  }
}

function skillBody(ctx) {
  return isRecord(ctx.state.skillProjection) && isRecord(ctx.state.skillProjection.body)
    ? ctx.state.skillProjection.body
    : { version: 1, skills: [] }
}
