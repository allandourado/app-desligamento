import './style.css'
import { format, subDays, isBefore, parseISO } from 'date-fns'
import JSZip from 'jszip'
import { saveAs } from 'file-saver'
import { jsPDF } from 'jspdf'
import html2canvas from 'html2canvas'

type EvaluationType = 'EXPERIENCE' | 'INDETERMINATE'
type EvaluationMode = 'SIMPLE' | 'DETAILED'

interface Attachment {
  name: string
  content: string // Base64
}

interface Occurrence {
  id: string
  date: string
  category: string
  type: string
  typeId: string
  points: number
  observation: string
  attachment?: Attachment
}

interface ScoreItem {
  id: string
  label: string
  points: number
}

interface ScoreCategory {
  id: string
  label: string
  types: ScoreItem[]
}

interface AdminSettings {
  passwordHash: string
  scores: {
    EXPERIENCE: ScoreCategory[]
    INDETERMINATE: ScoreCategory[]
  }
}

interface SimpleOccurrence {
  date: string
  attachment?: Attachment
}

interface AppState {
  step: 'SETUP' | 'EVALUATION' | 'RESULT' | 'ADMIN'
  employeeName: string
  matricula: string
  setor: string
  supervisorName: string
  hireDate: string
  evaluationType: EvaluationType
  evaluationMode: EvaluationMode
  simpleData: {
    absences: SimpleOccurrence[]
    warnings: SimpleOccurrence[]
    quartile4: boolean
    absencesIndeterminate: number
    absencesIndeterminateAttachment?: Attachment
    quartile4Attachment?: Attachment
  }
  occurrences: Occurrence[]
  comments: string
  admin: AdminSettings
}

const defaultScores: AdminSettings['scores'] = {
  EXPERIENCE: [
    { id: 'ABS', label: 'Absenteísmo', types: [
      { id: 'UNJUSTIFIED', label: 'Injustificado com advertência', points: -5 },
      { id: 'JUSTIFIED', label: 'Justificado', points: -1 }
    ]},
    { id: 'QUALIDADE', label: 'Qualidade', types: [
      { id: 'LOW_FEEDBACK', label: 'Notas baixas com feedback', points: -2 },
      { id: 'NCG', label: 'NCG (Não Conformidade Grave)', points: -3 }
    ]},
    { id: 'COMPORTAMENTO', label: 'Comportamento', types: [
      { id: 'BEHAVIOR_FEEDBACK', label: 'Desvio com feedback', points: -2 },
      { id: 'BEHAVIOR_WARNING', label: 'Desvio com advertência', points: -5 }
    ]},
    { id: 'PRODUTIVIDADE', label: 'Produtividade', types: [
      { id: 'PROD_WARNING', label: 'Baixa produção com feedback registrado', points: -2 }
    ]}
  ],
  INDETERMINATE: [
    { id: 'ABS', label: 'Absenteísmo', types: [
      { id: 'UNJUSTIFIED', label: 'Injustificado com advertência', points: -3 },
      { id: 'JUSTIFIED', label: 'Justificado', points: -1 }
    ]},
    { id: 'COMPORTAMENTO', label: 'Comportamento', types: [
      { id: 'BEHAVIOR_FEEDBACK', label: 'Desvio com feedback', points: -2 },
      { id: 'BEHAVIOR_WARNING', label: 'Desvio com advertência', points: -3 }
    ]},
    { id: 'QUALIDADE', label: 'Qualidade', types: [
      { id: 'LOW_FEEDBACK', label: 'Notas baixas com feedback', points: -2 },
      { id: 'NCG', label: 'NCG com advertência', points: -3 }
    ]},
    { id: 'PRODUTIVIDADE', label: 'Produtividade', types: [
      { id: 'PROD_WARNING', label: 'Baixa produção com feedback registrado', points: -2 }
    ]}
  ]
}

let state: AppState = {
  step: 'SETUP',
  employeeName: '',
  matricula: '',
  setor: '',
  supervisorName: '',
  hireDate: '',
  evaluationType: 'EXPERIENCE',
  evaluationMode: 'SIMPLE',
  simpleData: {
    absences: [],
    warnings: [],
    quartile4: false,
    absencesIndeterminate: 0,
    absencesIndeterminateAttachment: undefined,
    quartile4Attachment: undefined
  },
  occurrences: [],
  comments: '',
  admin: {
    passwordHash: 'admin123',
    scores: defaultScores
  }
}

const app = document.querySelector<HTMLDivElement>('#app')!

function saveState() {
  try {
    // Admin settings are permanent
    localStorage.setItem('avaliacao_admin', JSON.stringify(state.admin))
    
    // Evaluation data is session-based (resets on browser close)
    const { admin, ...sessionData } = state
    sessionStorage.setItem('avaliacao_session', JSON.stringify(sessionData))
  } catch (e) {
    console.warn('Storage limit reached.')
  }
}

function setState(newState: Partial<AppState>) {
  state = { ...state, ...newState }
  saveState()
  render()
}

// Load Admin Settings (Permanent)
const savedAdmin = localStorage.getItem('avaliacao_admin')
if (savedAdmin) {
  try {
    state.admin = JSON.parse(savedAdmin)
    if (!state.admin.scores) {
      state.admin.scores = defaultScores
    } else {
      const hasProd = state.admin.scores.INDETERMINATE.find((c: ScoreCategory) => c.id === 'PRODUTIVIDADE')
      if (!hasProd) {
        state.admin.scores.INDETERMINATE.push({
          id: 'PRODUTIVIDADE', label: 'Produtividade', types: [
            { id: 'PROD_WARNING', label: 'Baixa produção com feedback registrado', points: -2 }
          ]
        })
      }
    }
  } catch (e) {}
}

// Load Session Data (Temporary)
const savedSession = sessionStorage.getItem('avaliacao_session')
if (savedSession) {
  try {
    const parsed = JSON.parse(savedSession)
    state = { ...state, ...parsed }
  } catch (e) {}
}

function getTenure(hireDate: string): EvaluationType {
  if (!hireDate) return 'EXPERIENCE'
  const hire = parseISO(hireDate)
  const today = new Date()
  const diffDays = Math.ceil((today.getTime() - hire.getTime()) / (1000 * 60 * 60 * 24))
  return diffDays <= 90 ? 'EXPERIENCE' : 'INDETERMINATE'
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.readAsDataURL(file)
    reader.onload = () => {
      const base64 = (reader.result as string).split(',')[1]
      resolve(base64)
    }
    reader.onerror = error => reject(error)
  })
}

function render() {
  if (state.step === 'SETUP') {
    renderSetup()
  } else if (state.step === 'EVALUATION') {
    renderEvaluation()
  } else if (state.step === 'RESULT') {
    renderResult()
  } else if (state.step === 'ADMIN') {
    renderAdmin()
  }
}

function renderSetup() {
  app.innerHTML = `
    <div class="container fade-in">
      <div style="display: flex; justify-content: flex-end; margin-bottom: -1rem;">
        <button onclick="window.requestAdmin()" class="btn-icon" title="Administrador">⚙️</button>
      </div>
      <h1>Avaliação de Desligamento</h1>
      <p class="subtitle">Análise técnica para validação de decisões</p>
      
      <div class="steps">
        <div class="step active">1</div>
        <div class="step">2</div>
        <div class="step">3</div>
      </div>

      <form id="setup-form">
        <div class="grid-2">
          <div class="form-group">
            <label>Nome do Funcionário</label>
            <input type="text" id="employeeName" value="${state.employeeName}" required placeholder="Nome completo">
          </div>
          <div class="form-group">
            <label>Matrícula</label>
            <input type="text" id="matricula" value="${state.matricula}" required placeholder="00000">
          </div>
        </div>

        <div class="grid-2">
          <div class="form-group">
            <label>Operação</label>
            <input type="text" id="setor" value="${state.setor}" required placeholder="Ex: Atendimento">
          </div>
          <div class="form-group">
            <label>Nome do Supervisor Avaliador</label>
            <input type="text" id="supervisorName" value="${state.supervisorName}" required placeholder="Seu nome">
          </div>
        </div>

        <div class="form-group">
          <label>Data de Admissão</label>
          <input type="date" id="hireDate" value="${state.hireDate}" required>
        </div>

        <button type="submit" class="btn btn-primary btn-full">
          Iniciar Avaliação
        </button>
      </form>
    </div>
  `

  ;(window as any).requestAdmin = () => {
    const pw = prompt('Digite a senha de administrador:')
    if (pw === state.admin.passwordHash) {
      setState({ step: 'ADMIN' })
    } else if (pw !== null) {
      alert('Senha incorreta!')
    }
  }

  const setupForm = document.querySelector('#setup-form')
  
  // Persistence on input
  const fields = ['employeeName', 'matricula', 'setor', 'supervisorName', 'hireDate']
  fields.forEach(field => {
    document.querySelector(`#${field}`)?.addEventListener('input', (e) => {
      const val = (e.target as HTMLInputElement).value
      ;(state as any)[field] = val
      saveState()
    })
  })

  setupForm?.addEventListener('submit', (e) => {
    e.preventDefault()
    const employeeName = (document.querySelector('#employeeName') as HTMLInputElement).value
    const matricula = (document.querySelector('#matricula') as HTMLInputElement).value
    const setor = (document.querySelector('#setor') as HTMLInputElement).value
    const supervisorName = (document.querySelector('#supervisorName') as HTMLInputElement).value
    const hireDate = (document.querySelector('#hireDate') as HTMLInputElement).value
    const type = getTenure(hireDate)
    
    setState({
      employeeName,
      matricula,
      setor,
      supervisorName,
      hireDate,
      evaluationType: type,
      step: 'EVALUATION'
    })
  })
}

function renderAdmin() {
  const renderScoreInputs = (type: EvaluationType) => {
    const cats = state.admin.scores[type]
    return cats.map(cat => `
      <div style="margin-bottom: 1.5rem; border-bottom: 1px solid #eee; padding-bottom: 1rem;">
        <h4 style="color: var(--primary); margin-bottom: 0.5rem;">${cat.label}</h4>
        ${cat.types.map(t => `
          <div class="grid-2" style="margin-bottom: 0.5rem; align-items: center;">
            <label style="font-size: 0.85rem;">${t.label}</label>
            <input type="number" step="1" 
              value="${t.points}" 
              onchange="window.updateAdminScore('${type}', '${cat.id}', '${t.id}', this.value)"
              style="padding: 0.25rem 0.5rem; width: 80px; justify-self: end;">
          </div>
        `).join('')}
      </div>
    `).join('')
  }

  app.innerHTML = `
    <div class="container fade-in">
      <div class="header-meta">
        <h2>Configurações do Sistema</h2>
        <button class="btn btn-outline" onclick="window.setStep('SETUP')">Sair</button>
      </div>

      <div class="card-section">
        <h3>Alterar Senha de Admin</h3>
        <div class="form-group">
          <input type="text" id="admin-password" value="${state.admin.passwordHash}">
        </div>
      </div>

      <div class="card-section">
        <h3 style="margin-bottom: 1rem;">Pontuações: Período de Experiência</h3>
        ${renderScoreInputs('EXPERIENCE')}
      </div>

      <div class="card-section">
        <h3 style="margin-bottom: 1rem;">Pontuações: Período Indeterminado</h3>
        ${renderScoreInputs('INDETERMINATE')}
      </div>

      <button class="btn btn-primary btn-full" onclick="window.saveAdminSettings()">Salvar Configurações</button>
    </div>
  `

  ;(window as any).updateAdminScore = (evalType: EvaluationType, catId: string, typeId: string, value: string) => {
    const points = parseInt(value) || 0
    const cat = state.admin.scores[evalType].find(c => c.id === catId)
    const type = cat?.types.find(t => t.id === typeId)
    if (type) type.points = points
  }

  ;(window as any).setStep = (step: any) => setState({ step })

  ;(window as any).saveAdminSettings = () => {
    const passwordHash = (document.querySelector('#admin-password') as HTMLInputElement).value
    setState({
      admin: {
        ...state.admin,
        passwordHash
      },
      step: 'SETUP'
    })
    alert('Configurações salvas!')
  }
}

function renderEvaluation() {
  const typeLabel = state.evaluationType === 'EXPERIENCE' ? 'Período de Experiência' : 'Período Indeterminado'

  app.innerHTML = `
    <div class="container fade-in">
      <div class="header-meta">
        <div>
          <h2>${state.employeeName}</h2>
          <span class="tag ${state.evaluationType === 'EXPERIENCE' ? 'tag-amber' : 'tag-blue'}">${typeLabel}</span>
        </div>
        <div style="display: flex; gap: 0.5rem;">
          <button class="btn btn-outline" id="back-to-setup">Voltar</button>
          <button class="btn btn-danger btn-outline" onclick="window.fullReset()" title="Limpar tudo e voltar ao início">Resetar</button>
        </div>
      </div>

      <div class="steps">
        <div class="step completed">1</div>
        <div class="step active">2</div>
        <div class="step">3</div>
      </div>

      <div class="form-group">
        <label>Tipo de Avaliação</label>
        <div class="grid-2">
          <button class="btn ${state.evaluationMode === 'SIMPLE' ? 'btn-primary' : 'btn-outline'}" onclick="window.setMode('SIMPLE')">Avaliação Simples</button>
          <button class="btn ${state.evaluationMode === 'DETAILED' ? 'btn-primary' : 'btn-outline'}" onclick="window.setMode('DETAILED')">Avaliação Detalhada</button>
        </div>
      </div>

      <div id="evaluation-content">
        ${state.evaluationMode === 'SIMPLE' ? renderSimpleForm() : renderDetailedForm()}
      </div>

      <div class="form-group" style="margin-top: 2rem;">
        <label>Comentários do Avaliador</label>
        <textarea id="comments-input" placeholder="Insira observações adicionais...">${state.comments}</textarea>
      </div>

      <button class="btn btn-primary btn-full" id="finish-evaluation" style="margin-top: 1rem;">
        Finalizar e Gerar Resumo
      </button>
    </div>
  `

  ;(window as any).setMode = (mode: EvaluationMode) => setState({ evaluationMode: mode })
  
  document.querySelector('#back-to-setup')?.addEventListener('click', () => setState({ step: 'SETUP' }))
  
  document.querySelector('#comments-input')?.addEventListener('input', (e) => {
    state.comments = (e.target as HTMLTextAreaElement).value
    saveState()
  })

  document.querySelector('#finish-evaluation')?.addEventListener('click', () => {
    if (state.evaluationMode === 'SIMPLE' && state.evaluationType === 'INDETERMINATE') {
      if (state.simpleData.absencesIndeterminate > 0 && !state.simpleData.absencesIndeterminateAttachment) {
        return alert('Anexo obrigatório para o registro de faltas.')
      }
      if (state.simpleData.quartile4 && !state.simpleData.quartile4Attachment) {
        return alert('Anexo obrigatório para o registro de 4º quartil.')
      }
    }
    setState({ step: 'RESULT' })
  })

  attachEvaluationListeners()
}

function renderSimpleForm() {
  if (state.evaluationType === 'EXPERIENCE') {
    const isTermination = checkSimpleExperienceTermination()
    return `
      <div class="card-section">
        <h3>Registrar Faltas (Últimos 30 dias)</h3>
        <p class="text-muted" style="font-size: 0.85rem; margin-bottom: 1rem;">3+ faltas indicam desligamento.</p>
        <div class="form-group">
          <label>Data da Falta</label>
          <input type="date" id="simple-absence-date">
        </div>
        <div class="form-group">
          <label><strong>Anexar Evidência (OBRIGATÓRIO)</strong></label>
          <input type="file" id="simple-absence-file" class="file-input">
        </div>
        <button class="btn btn-primary btn-full" onclick="window.addSimpleAbsence()">+ Registrar Falta</button>
        
        <div style="margin-top: 1.5rem;">
          <label>Faltas Registradas (${state.simpleData.absences.length})</label>
          <div class="occurrence-list" style="margin-top: 0.5rem; background: #fafafa;">
            ${state.simpleData.absences.length === 0 ? '<p style="padding: 1rem; text-align: center; color: var(--text-muted);">Nenhuma falta registrada.</p>' : ''}
            ${state.simpleData.absences.map((occ, i) => `
              <div class="occurrence-item">
                <div style="flex: 1;">
                  <div style="font-weight: 600;">Data: ${format(parseISO(occ.date), 'dd/MM/yyyy')}</div>
                  ${occ.attachment ? `<div style="font-size: 0.75rem; color: var(--primary);">📎 ${occ.attachment.name}</div>` : ''}
                </div>
                <button class="btn btn-danger btn-outline" style="padding: 0.25rem 0.5rem;" onclick="window.removeSimpleAbsence(${i})">×</button>
              </div>
            `).join('')}
          </div>
        </div>
      </div>

      <div class="card-section">
        <h3>Registrar Advertências</h3>
        <p class="text-muted" style="font-size: 0.85rem; margin-bottom: 1rem;">2+ advertências indicam desligamento.</p>
        <div class="form-group">
          <label>Data da Advertência</label>
          <input type="date" id="simple-warning-date">
        </div>
        <div class="form-group">
          <label><strong>Anexar Evidência (OBRIGATÓRIO)</strong></label>
          <input type="file" id="simple-warning-file" class="file-input">
        </div>
        <button class="btn btn-primary btn-full" onclick="window.addSimpleWarning()">+ Registrar Advertência</button>

        <div style="margin-top: 1.5rem;">
          <label>Advertências Registradas (${state.simpleData.warnings.length})</label>
          <div class="occurrence-list" style="margin-top: 0.5rem; background: #fafafa;">
            ${state.simpleData.warnings.length === 0 ? '<p style="padding: 1rem; text-align: center; color: var(--text-muted);">Nenhuma advertência registrada.</p>' : ''}
            ${state.simpleData.warnings.map((occ, i) => `
              <div class="occurrence-item">
                <div style="flex: 1;">
                  <div style="font-weight: 600;">Data: ${format(parseISO(occ.date), 'dd/MM/yyyy')}</div>
                  ${occ.attachment ? `<div style="font-size: 0.75rem; color: var(--primary);">📎 ${occ.attachment.name}</div>` : ''}
                </div>
                <button class="btn btn-danger btn-outline" style="padding: 0.25rem 0.5rem;" onclick="window.removeSimpleWarning(${i})">×</button>
              </div>
            `).join('')}
          </div>
        </div>
      </div>

      <div class="simple-analysis-result ${isTermination ? 'result-termination' : 'result-keep'}">
        ${isTermination ? 'INDICADO AO DESLIGAMENTO' : 'DENTRO DOS PADRÕES ACEITÁVEIS'}
      </div>
    `
  } else {
    const isTermination = state.simpleData.absencesIndeterminate >= 10 || state.simpleData.quartile4
    return `
      <div class="card-section">
        <h3>Critérios de Desempenho</h3>
        <div class="form-group">
          <label>O operador tem mais de 10 faltas nos últimos 3 meses?</label>
          <input type="number" value="${state.simpleData.absencesIndeterminate}" oninput="window.updateAbsencesInd(this.value)" placeholder="Qtd de faltas">
        </div>
        <div class="form-group" id="ind-absence-file-group" style="display: ${state.simpleData.absencesIndeterminate > 0 ? 'block' : 'none'};">
          <label><strong>Anexar Evidência de Faltas (OBRIGATÓRIO)</strong></label>
          <input type="file" class="file-input" onchange="window.updateIndAbsenceFile(this)">
          ${state.simpleData.absencesIndeterminateAttachment ? `<div style="font-size: 0.75rem; color: var(--primary); margin-top: 0.25rem;">📎 ${state.simpleData.absencesIndeterminateAttachment.name}</div>` : ''}
        </div>
        <div class="form-group">
          <label class="checkbox-container" style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
            <input type="checkbox" ${state.simpleData.quartile4 ? 'checked' : ''} onchange="window.updateQuartile4(this.checked)">
            O operador está no 4º quartil de desempenho nos últimos 3 meses?
          </label>
        </div>
        <div class="form-group" id="ind-quartile-file-group" style="display: ${state.simpleData.quartile4 ? 'block' : 'none'};">
          <label><strong>Anexar Evidência de Quartil (OBRIGATÓRIO)</strong></label>
          <input type="file" class="file-input" onchange="window.updateIndQuartileFile(this)">
          ${state.simpleData.quartile4Attachment ? `<div style="font-size: 0.75rem; color: var(--primary); margin-top: 0.25rem;">📎 ${state.simpleData.quartile4Attachment.name}</div>` : ''}
        </div>
      </div>

      <div class="simple-analysis-result ${isTermination ? 'result-termination' : 'result-keep'}">
        ${isTermination ? 'INDICADO AO DESLIGAMENTO' : 'DENTRO DOS PADRÕES ACEITÁVEIS'}
      </div>
    `
  }
}

function renderDetailedForm() {
  const totalScore = calculateScore()
  const categories = state.admin.scores[state.evaluationType]

  return `
    <div class="card-section">
      <div class="score-display">${totalScore} Pontos</div>
      <p style="text-align: center; color: var(--text-muted);">Pontuação Final acumulada</p>
    </div>

    <div class="card-section">
      <h3>Adicionar Ocorrência</h3>
      <div class="form-group">
        <label>Categoria</label>
        <select id="new-category" onchange="window.refreshCategoryTypes(this.value)">
          ${categories.map(c => `<option value="${c.id}">${c.label}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Tipo de Ocorrência</label>
        <select id="new-type"></select>
      </div>
      <div class="grid-2">
        <div class="form-group">
          <label>Data</label>
          <input type="date" id="new-date">
        </div>
        <div class="form-group">
          <label><strong>Evidência (OBRIGATÓRIO)</strong></label>
          <input type="file" id="new-file" class="file-input">
        </div>
      </div>
      <div class="form-group">
        <label>Evidência/Observação</label>
        <input type="text" id="new-obs" placeholder="Ex: Protocolo do feedback">
      </div>
      <button class="btn btn-primary btn-full" onclick="window.addOccurrence()">Adicionar à Pontuação</button>
    </div>

    <div class="card-section">
      <h3>Ocorrências Registradas</h3>
      <div class="occurrence-list">
        ${state.occurrences.length === 0 ? '<p style="padding: 1rem; text-align: center; color: var(--text-muted);">Nenhuma ocorrência registrada.</p>' : ''}
        ${state.occurrences.map(o => `
          <div class="occurrence-item">
            <div style="flex: 1">
              <div style="font-weight: 600;">${o.category}: ${o.type}</div>
              <div style="font-size: 0.85rem; color: var(--text-muted);">Data: ${format(parseISO(o.date), 'dd/MM/yyyy')} | ${o.observation}</div>
              ${o.attachment ? `<div style="font-size: 0.75rem; color: var(--primary);">📎 ${o.attachment.name}</div>` : ''}
            </div>
            <div style="color: var(--danger); font-weight: 700; width: 40px; text-align: right;">${o.points}</div>
            <button class="btn btn-danger btn-outline" style="padding: 0.25rem 0.5rem;" onclick="window.removeOccurrence('${o.id}')">×</button>
          </div>
        `).join('')}
      </div>
    </div>

    <div class="legend-card">
      <strong>Legenda Sugestão Final:</strong><br><br>
      ${getLegend()}
    </div>
  `
}

function attachEvaluationListeners() {
  const ninetyDaysAgo = subDays(new Date(), 90)

  ;(window as any).addSimpleAbsence = async () => {
    const input = document.querySelector('#simple-absence-date') as HTMLInputElement
    const fileInput = document.querySelector('#simple-absence-file') as HTMLInputElement
    const val = input.value
    if (!val) return alert('Selecione uma data')
    if (isBefore(parseISO(val), ninetyDaysAgo)) return alert('Data inválida.')
    if (!fileInput.files || !fileInput.files[0]) return alert('Arquivo obrigatório.')

    const attachment = { name: fileInput.files[0].name, content: await fileToBase64(fileInput.files[0]) }
    state.simpleData.absences.push({ date: val, attachment })
    saveState()
    render()
  }
  ;(window as any).removeSimpleAbsence = (i: number) => {
    state.simpleData.absences.splice(i, 1)
    saveState()
    render()
  }

  ;(window as any).addSimpleWarning = async () => {
    const input = document.querySelector('#simple-warning-date') as HTMLInputElement
    const fileInput = document.querySelector('#simple-warning-file') as HTMLInputElement
    const val = input.value
    if (!val) return alert('Selecione uma data')
    if (isBefore(parseISO(val), ninetyDaysAgo)) return alert('Data inválida.')
    if (!fileInput.files || !fileInput.files[0]) return alert('Arquivo obrigatório.')

    const attachment = { name: fileInput.files[0].name, content: await fileToBase64(fileInput.files[0]) }
    state.simpleData.warnings.push({ date: val, attachment })
    saveState()
    render()
  }
  ;(window as any).removeSimpleWarning = (i: number) => {
    state.simpleData.warnings.splice(i, 1)
    saveState()
    render()
  }

  ;(window as any).updateAbsencesInd = (val: string) => {
    state.simpleData.absencesIndeterminate = parseInt(val) || 0
    saveState()
    
    const fileGroup = document.querySelector('#ind-absence-file-group') as HTMLElement
    if (fileGroup) fileGroup.style.display = state.simpleData.absencesIndeterminate > 0 ? 'block' : 'none'

    const resultDiv = document.querySelector('.simple-analysis-result') as HTMLElement
    if (resultDiv) {
      const isTermination = state.simpleData.absencesIndeterminate >= 10 || state.simpleData.quartile4
      if (isTermination) {
        resultDiv.className = 'simple-analysis-result result-termination'
        resultDiv.innerText = 'INDICADO AO DESLIGAMENTO'
      } else {
        resultDiv.className = 'simple-analysis-result result-keep'
        resultDiv.innerText = 'DENTRO DOS PADRÕES ACEITÁVEIS'
      }
    }
  }
  ;(window as any).updateQuartile4 = (val: boolean) => {
    state.simpleData.quartile4 = val
    saveState()
    
    const fileGroup = document.querySelector('#ind-quartile-file-group') as HTMLElement
    if (fileGroup) fileGroup.style.display = state.simpleData.quartile4 ? 'block' : 'none'

    const resultDiv = document.querySelector('.simple-analysis-result') as HTMLElement
    if (resultDiv) {
      const isTermination = state.simpleData.absencesIndeterminate >= 10 || state.simpleData.quartile4
      if (isTermination) {
        resultDiv.className = 'simple-analysis-result result-termination'
        resultDiv.innerText = 'INDICADO AO DESLIGAMENTO'
      } else {
        resultDiv.className = 'simple-analysis-result result-keep'
        resultDiv.innerText = 'DENTRO DOS PADRÕES ACEITÁVEIS'
      }
    }
  }

  ;(window as any).updateIndAbsenceFile = async (input: HTMLInputElement) => {
    if (input.files && input.files[0]) {
      const content = await fileToBase64(input.files[0])
      state.simpleData.absencesIndeterminateAttachment = { name: input.files[0].name, content }
      saveState()
      render()
    }
  }

  ;(window as any).updateIndQuartileFile = async (input: HTMLInputElement) => {
    if (input.files && input.files[0]) {
      const content = await fileToBase64(input.files[0])
      state.simpleData.quartile4Attachment = { name: input.files[0].name, content }
      saveState()
      render()
    }
  }

  ;(window as any).refreshCategoryTypes = (catId: string) => {
    const categories = state.admin.scores[state.evaluationType]
    const types = categories.find(c => c.id === catId)?.types || []
    const select = document.querySelector('#new-type') as HTMLSelectElement
    if (select) {
      select.innerHTML = types.map(t => `<option value="${t.id}">${t.label} (${t.points} pts)</option>`).join('')
    }
  }

  ;(window as any).addOccurrence = async () => {
    const catId = (document.querySelector('#new-category') as HTMLSelectElement).value
    const typeId = (document.querySelector('#new-type') as HTMLSelectElement).value
    const date = (document.querySelector('#new-date') as HTMLInputElement).value
    const obs = (document.querySelector('#new-obs') as HTMLInputElement).value
    const fileInput = document.querySelector('#new-file') as HTMLInputElement

    if (!date) return alert('Data obrigatória.')
    if (!fileInput.files || !fileInput.files[0]) return alert('Arquivo obrigatório.')

    const categories = state.admin.scores[state.evaluationType]
    const category = categories.find(c => c.id === catId)
    const typeData = category?.types.find(t => t.id === typeId)
    
    if (typeData) {
      const attachment = { name: fileInput.files[0].name, content: await fileToBase64(fileInput.files[0]) }
      state.occurrences.push({
        id: Math.random().toString(36).substr(2, 9),
        category: category!.label,
        type: typeData.label,
        typeId: typeData.id,
        points: typeData.points,
        date: date,
        observation: obs,
        attachment
      })
      saveState()
      render()
    }
  }

  ;(window as any).removeOccurrence = (id: string) => {
    state.occurrences = state.occurrences.filter(o => o.id !== id)
    saveState()
    render()
  }

  if (state.evaluationMode === 'DETAILED') {
    const catSelect = document.querySelector('#new-category') as HTMLSelectElement
    if (catSelect) (window as any).refreshCategoryTypes(catSelect.value)
  }

  ;(window as any).fullReset = () => {
    if (confirm('Resetar tudo?')) {
      localStorage.removeItem('avaliacao_state')
      state = {
        step: 'SETUP', employeeName: '', matricula: '', setor: '', supervisorName: '', hireDate: '',
        evaluationType: 'EXPERIENCE', evaluationMode: 'SIMPLE',
        simpleData: { absences: [], warnings: [], quartile4: false, absencesIndeterminate: 0, absencesIndeterminateAttachment: undefined, quartile4Attachment: undefined },
        occurrences: [], comments: '', admin: state.admin
      }
      render()
    }
  }
}

function checkSimpleExperienceTermination(): boolean {
  const thirtyDaysAgo = subDays(new Date(), 30)
  const recentAbsences = state.simpleData.absences.filter(d => !isBefore(parseISO(d.date), thirtyDaysAgo))
  return recentAbsences.length >= 3 || state.simpleData.warnings.length >= 2
}

function calculateScore(): number {
  return state.occurrences.reduce((sum, o) => sum + o.points, 0)
}

function getLegend() {
  if (state.evaluationType === 'EXPERIENCE') {
    return `<div class="legend-item">-1 a -5 pts: Acompanhamento. Abaixo de -6 pts: Desligamento.</div>`
  }
  return `<div class="legend-item">0 a -5 pts: Manter. -6 a -10 pts: Avaliar. Abaixo de -10 pts: Desligamento.</div>`
}

function renderResult() {
  const totalScore = calculateScore()
  const isExperience = state.evaluationType === 'EXPERIENCE'
  let suggestion = ''
  let statusClass = 'result-keep'

  if (state.evaluationMode === 'SIMPLE') {
    const term = isExperience ? checkSimpleExperienceTermination() : (state.simpleData.absencesIndeterminate >= 10 || state.simpleData.quartile4)
    suggestion = term ? 'RECOMENDADO O DESLIGAMENTO' : 'MANTER COLABORADOR'
    statusClass = term ? 'result-termination' : 'result-keep'
  } else {
    if (isExperience) {
      if (totalScore <= -6) { suggestion = 'RECOMENDADO O DESLIGAMENTO'; statusClass = 'result-termination'; }
      else if (totalScore < 0) { suggestion = 'AVALIAR CONTINUIDADE'; statusClass = 'result-amber'; }
      else suggestion = 'MANTER COLABORADOR'
    } else {
      if (totalScore < -10) { suggestion = 'RECOMENDADO O DESLIGAMENTO'; statusClass = 'result-termination'; }
      else if (totalScore <= -6) { suggestion = 'AVALIAR POSSIBILIDADE'; statusClass = 'result-amber'; }
      else suggestion = 'MANTER COLABORADOR'
    }
  }

  const resultHTML = `
    <div class="container fade-in" id="result-page">
      <h1>Resumo Técnico</h1>
      <p class="subtitle">Documento de Apoio para Decisão de Desligamento</p>
      
      <div class="card-section">
        <div class="header-meta" style="margin-bottom: 1rem; border-bottom: 1px solid var(--border); padding-bottom: 0.5rem;">
          <div style="display: flex; flex-direction: column; gap: 0.5rem;">
            <div style="display: flex; gap: 0.5rem;">
              <span class="tag ${state.evaluationType === 'EXPERIENCE' ? 'tag-amber' : 'tag-blue'}">
                ${state.evaluationType === 'EXPERIENCE' ? 'Experiência' : 'Indeterminado'}
              </span>
              <span class="tag" style="background:#f3f4f6;color:#374151;">
                ${state.evaluationMode === 'SIMPLE' ? 'Simples' : 'Detalhada'}
              </span>
            </div>
            <h2 style="margin: 0;">${state.employeeName}</h2>
          </div>
          <div style="text-align: right; font-size: 0.85rem; color: var(--text-muted);">
            Data: ${format(new Date(), 'dd/MM/yyyy')}
          </div>
        </div>
        <div class="grid-2">
          <div>
            <strong>Matrícula:</strong> ${state.matricula}<br>
            <strong>Operação:</strong> ${state.setor}<br>
            <strong>Admissão:</strong> ${format(parseISO(state.hireDate), 'dd/MM/yyyy')}
          </div>
          <div style="text-align: right;">
            <strong>Supervisor:</strong> ${state.supervisorName}
          </div>
        </div>
      </div>

      <div class="card-section ${statusClass}" style="text-align: center; padding: 2rem;">
          <p style="text-transform: uppercase; letter-spacing: 1px; font-size: 0.85rem; margin-bottom: 0.5rem; opacity: 0.8;">Parecer Técnico</p>
          <h2 style="margin: 0; font-size: 1.8rem; color: inherit;">${suggestion}</h2>
          ${state.evaluationMode === 'DETAILED' ? `
            <div style="margin-top: 1rem; display: inline-block; padding: 0.3rem 1rem; background: rgba(255,255,255,0.2); border-radius: 50px; font-weight: 800;">
              Score: ${totalScore} pts
            </div>
          ` : ''}
      </div>

      <div class="card-section">
        <h3>Evidências da Análise</h3>
        ${state.evaluationMode === 'SIMPLE' ? renderSimpleEvidences() : renderDetailedEvidences()}
      </div>

      ${state.comments ? `
        <div class="card-section">
          <h3>Comentários Adicionais</h3>
          <p style="white-space: pre-wrap;">${state.comments}</p>
        </div>
      ` : ''}
    </div>
  `

  app.innerHTML = `
    ${resultHTML}
    <div class="container" style="margin-top: -1rem;">
      <div class="card-section" style="background: #f8fafc; border: 1px dashed #cbd5e1;">
        <h3 style="color: var(--primary); margin-bottom: 1rem;">📦 Pacote de Análise ZIP</h3>
        <p style="font-size: 0.9rem; margin-bottom: 1.5rem;">Baixe o pacote contendo o Resumo HTML (idêntico à tela), o PDF e as Evidências.</p>
        <button class="btn btn-primary btn-full" id="download-zip-btn">Gerar e Baixar Pacote ZIP</button>
      </div>
      <div class="grid-2" style="margin-top: 2rem;">
        <button class="btn btn-outline" id="back-to-eval">Voltar</button>
        <button class="btn btn-danger btn-outline" id="restart">Nova Avaliação</button>
      </div>
    </div>
  `

  document.querySelector('#back-to-eval')?.addEventListener('click', () => setState({ step: 'EVALUATION' }))
  document.querySelector('#restart')?.addEventListener('click', () => (window as any).fullReset())

  document.querySelector('#download-zip-btn')?.addEventListener('click', async () => {
    const btn = document.querySelector('#download-zip-btn') as HTMLButtonElement
    btn.disabled = true; btn.innerText = 'Gerando...'

    try {
      const zip = new JSZip()
      const evidenceFolder = zip.folder('evidencias')
      const occurrencesHTML: string[] = []
      
      const processAttachment = (occ: any, label: string) => {
        if (occ.attachment) {
          evidenceFolder?.file(occ.attachment.name, occ.attachment.content, { base64: true })
          occurrencesHTML.push(`<li>${label} - <a href="./evidencias/${occ.attachment.name}" target="_blank">Abrir Arquivo</a></li>`)
        }
      }

      state.simpleData.absences.forEach(a => processAttachment(a, `Falta em ${format(parseISO(a.date), 'dd/MM/yyyy')}`))
      state.simpleData.warnings.forEach(w => processAttachment(w, `Advertência em ${format(parseISO(w.date), 'dd/MM/yyyy')}`))
      state.occurrences.forEach(o => processAttachment(o, `${o.category}: ${o.type} (${format(parseISO(o.date), 'dd/MM/yyyy')})`))
      
      if (state.simpleData.absencesIndeterminateAttachment) {
        processAttachment({ attachment: state.simpleData.absencesIndeterminateAttachment }, 'Evidência Faltas')
      }
      if (state.simpleData.quartile4Attachment) {
        processAttachment({ attachment: state.simpleData.quartile4Attachment }, 'Evidência Quartil')
      }

      const fullStyles = `
        :root { --primary: #2563eb; --danger: #dc2626; --success: #16a34a; --amber: #d97706; --text-main: #1e293b; --text-muted: #64748b; --bg-main: #f8fafc; --border: #e2e8f0; }
        body { font-family: sans-serif; background: var(--bg-main); color: var(--text-main); margin: 0; padding: 40px 20px; line-height: 1.5; }
        .container { max-width: 800px; margin: 0 auto; background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
        h1 { color: var(--primary); text-align: center; margin-top: 0; }
        .subtitle { text-align: center; color: var(--text-muted); margin-top: -1rem; margin-bottom: 2rem; }
        .card-section { border: 1px solid var(--border); border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem; }
        .tag { display: inline-block; padding: 0.25rem 0.75rem; border-radius: 50px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; }
        .tag-amber { background: #fef3c7; color: #92400e; }
        .tag-blue { background: #dbeafe; color: #1e40af; }
        .result-termination { background: #fee2e2; color: #991b1b; border-color: #fecaca; }
        .result-keep { background: #dcfce7; color: #166534; border-color: #bbf7d0; }
        .result-amber { background: #fef3c7; color: #92400e; border-color: #fde68a; }
        h3 { margin-top: 0; border-bottom: 1px solid var(--border); padding-bottom: 0.5rem; margin-bottom: 1rem; color: var(--primary); }
        ul { padding-left: 1.5rem; }
        li { margin-bottom: 0.5rem; }
        a { color: var(--primary); text-decoration: none; font-weight: bold; }
        a:hover { text-decoration: underline; }
      `

      const reportHTMLContent = `
        <!DOCTYPE html>
        <html lang="pt-br">
        <head>
            <meta charset="UTF-8">
            <title>Resumo - ${state.employeeName}</title>
            <style>${fullStyles}</style>
        </head>
        <body>
            ${resultHTML}
            <div class="container" style="margin-top: 1.5rem;">
                <div class="card-section">
                    <h3>Arquivos de Evidência (Clique para abrir)</h3>
                    <ul>${occurrencesHTML.join('')}</ul>
                </div>
            </div>
        </body>
        </html>
      `
      zip.file('Resumo_Tecnico.html', reportHTMLContent)

      // Generate PDF from the current screen
      const resultElement = document.querySelector('#result-page') as HTMLElement
      const canvas = await html2canvas(resultElement, { scale: 2 })
      const imgData = canvas.toDataURL('image/png')
      const pdf = new jsPDF('p', 'mm', 'a4')
      const pdfWidth = pdf.internal.pageSize.getWidth()
      const pdfHeight = (canvas.height * pdfWidth) / canvas.width
      pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight)
      const pdfBlob = pdf.output('blob')
      zip.file(`Resumo_Analise_${state.employeeName.replace(/ /g, '_')}.pdf`, pdfBlob)

      const content = await zip.generateAsync({ type: 'blob' })
      saveAs(content, `Analise_${state.employeeName.replace(/ /g, '_')}.zip`)
      alert('Pacote de Análise baixado com sucesso!')
    } catch (e) { alert('Erro ao gerar o pacote.') }
    finally { btn.disabled = false; btn.innerText = 'Gerar e Baixar Pacote ZIP' }
  })
}

function renderSimpleEvidences() {
  if (state.evaluationType === 'INDETERMINATE') {
    return `
      <div>
        <p><strong>Faltas (Últimos 3 meses):</strong> ${state.simpleData.absencesIndeterminate}</p>
        <p><strong>4º Quartil (Últimos 3 meses):</strong> ${state.simpleData.quartile4 ? 'Sim' : 'Não'}</p>
      </div>
    `
  }

  const abs = state.simpleData.absences.map(o => `<li>${format(parseISO(o.date), 'dd/MM/yyyy')}</li>`).join('')
  const war = state.simpleData.warnings.map(o => `<li>${format(parseISO(o.date), 'dd/MM/yyyy')}</li>`).join('')
  return `
    <div>
      <strong>Faltas:</strong> ${state.simpleData.absences.length}
      <ul>${abs || '<li>Nenhuma</li>'}</ul>
      <strong>Advertências:</strong> ${state.simpleData.warnings.length}
      <ul>${war || '<li>Nenhuma</li>'}</ul>
    </div>
  `
}

function renderDetailedEvidences() {
  if (state.occurrences.length === 0) return '<p>Nenhuma ocorrência.</p>'
  return `
    <ul style="list-style: none; padding: 0;">
      ${state.occurrences.map(o => `
        <li style="padding: 0.5rem; border-bottom: 1px solid var(--border);">
          <strong>${format(parseISO(o.date), 'dd/MM/yyyy')}</strong> | ${o.category}: ${o.type} 
          <span style="color:var(--danger); font-weight:700; float:right;">${o.points}</span>
        </li>
      `).join('')}
    </ul>
  `
}

render()
