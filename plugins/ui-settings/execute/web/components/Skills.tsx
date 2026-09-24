// 技能页（技能身份写入入口）：列表 + 新建 / 编辑 / 启停；客户端直写技能身份 body（put + add_gen）。

import { EmptyState, Field, IconButton, Section, TextButton, Toggle, useVc } from './ui.tsx'
import { isRecord } from '../config-model.ts'
import { listText, removeSkill, skillFromForm, skillList, skillTitle, toggleSkill, upsertSkill } from '../settings-model.ts'

export function SkillsPanel() {
  const vc = useVc()
  const skills = skillList(vc.state.skillProjection)
  return (
    <>
      <Section>
        <div className="settings-list">
          {skills.length === 0 ? <EmptyState nameKey="settings_empty_skills" hintKey="settings_empty_skills_hint" /> : null}
          {skills.map((skill) => (
            <SkillRow skill={skill} key={skill.id} />
          ))}
        </div>
      </Section>
      {vc.state.skillForm !== null ? (
        <SkillForm form={vc.state.skillForm} />
      ) : (
        <Section>
          <TextButton
            label={vc.text('settings_skills_new')}
            onClick={() => {
              vc.state.skillForm = emptySkillForm()
              vc.render()
            }}
          />
        </Section>
      )}
    </>
  )
}

function SkillRow(props: { skill: any }) {
  const vc = useVc()
  const skill = props.skill
  const enabled = skill.enabled !== false
  return (
    <div className="settings-list-item" data-saved-key={`skill:${skill.id}`} data-saved={vc.state.savedKey === `skill:${skill.id}` ? 'true' : undefined}>
      <span className="settings-list-main">{skillTitle(skill)}</span>
      <Toggle
        checked={enabled}
        label={vc.text(enabled ? 'settings_skills_disable' : 'settings_skills_enable')}
        onChange={async (next) => {
          vc.state.skillConfirmDelete = null
          await vc.writeSkillBody(toggleSkill(skillBody(vc), skill.id, next), `skill:${skill.id}`)
        }}
      />
      <IconButton
        name="pencil"
        label={vc.text('settings_skills_edit')}
        onClick={() => {
          vc.state.skillConfirmDelete = null
          vc.state.skillForm = {
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
          vc.render()
        }}
      />
      <IconButton
        name="trash-2"
        label={vc.text(vc.state.skillConfirmDelete === skill.id ? 'settings_confirm' : 'settings_skills_delete')}
        onClick={async () => {
          if (vc.state.skillConfirmDelete !== skill.id) {
            vc.state.skillConfirmDelete = skill.id
            vc.render()
            return
          }
          vc.state.skillConfirmDelete = null
          await vc.writeSkillBody(removeSkill(skillBody(vc), skill.id), `skill:${skill.id}`)
        }}
      />
    </div>
  )
}

function SkillForm(props: { form: any }) {
  const vc = useVc()
  const form = props.form
  const textField = (key: string, labelKey: string) => (
    <Field label={vc.text(labelKey)}>
      <input
        className="settings-input"
        type="text"
        value={form[key]}
        onChange={(event) => {
          form[key] = event.target.value
          vc.render()
        }}
      />
    </Field>
  )
  return (
    <Section>
      {textField('name', 'settings_skills_name')}
      {textField('description', 'settings_skills_description')}
      {textField('keywords', 'settings_skills_keywords')}
      {textField('file_globs', 'settings_skills_file_globs')}
      {textField('explicit', 'settings_skills_explicit')}
      <Field label={vc.text('settings_skills_scope')} labelable={false}>
        <select
          className="settings-select"
          value={form.scope_kind}
          aria-label={vc.text('settings_skills_scope')}
          onChange={(event) => {
            form.scope_kind = event.target.value
            vc.render()
          }}
        >
          <option value="global">{vc.text('settings_skills_scope_global')}</option>
          <option value="workspace">{vc.text('settings_skills_scope_workspace')}</option>
        </select>
      </Field>
      {form.scope_kind === 'workspace' ? (
        <Field label={vc.text('settings_memory_workspace_label')}>
          <input
            className="settings-input settings-mono"
            type="text"
            value={form.workspace_id}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              form.workspace_id = event.target.value
              vc.render()
            }}
          />
        </Field>
      ) : null}
      <Field label={vc.text('settings_skills_body')}>
        <textarea
          className="settings-input"
          rows={4}
          value={form.body}
          onChange={(event) => {
            form.body = event.target.value
            vc.render()
          }}
        />
      </Field>
      <div className="settings-guide-actions">
        <TextButton
          label={vc.text('settings_cancel')}
          onClick={() => {
            vc.state.skillForm = null
            vc.render()
          }}
        />
        <TextButton
          label={vc.text('settings_skills_save')}
          tone="accent"
          onClick={async () => {
            const id = form.id.length > 0 ? form.id : `sk-${Date.now().toString(36)}`
            const skill = skillFromForm(form, id, new Date().toISOString())
            const ok = await vc.writeSkillBody(upsertSkill(skillBody(vc), skill), `skill:${id}`)
            if (ok) {
              vc.state.skillForm = null
              vc.render()
            }
          }}
        />
      </div>
    </Section>
  )
}

function emptySkillForm(): any {
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

function skillBody(vc: any): any {
  return isRecord(vc.state.skillProjection) && isRecord(vc.state.skillProjection.body)
    ? vc.state.skillProjection.body
    : { version: 1, skills: [] }
}
