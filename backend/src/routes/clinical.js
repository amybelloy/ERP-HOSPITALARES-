'use strict';
/** Rotas assistenciais (PEP, leitos, triagem, prescrição, enfermagem). Montadas em /api após autenticação. */
const express = require('express');
const { requirePermission: can } = require('../middleware/auth');
const clinical = require('../services/clinicalService');
const rx = require('../services/prescriptionService');
const nursing = require('../services/nursingService');
const { audit } = require('../services/audit');

const r = express.Router();
const id = (req, n = 'id') => Number(req.params[n]);

// Painel / contexto do paciente
r.get('/clinical/patients', can('clinical.view', 'beds.view'), async (req, res) => res.json(await clinical.activePatients(req.query)));
r.get('/clinical/appointments/:id/context', can('clinical.view'), async (req, res) => {
  const ctx = await clinical.context(id(req));
  await audit(null, req.ctx, 'PEP_ACESSO', 'appointments', id(req), {}); // LGPD: rastreio de acesso ao prontuário
  res.json(ctx);
});
r.get('/clinical/appointments/:id/timeline', can('clinical.view'), async (req, res) => res.json(await clinical.timeline(id(req))));

// Alergias
r.get('/clinical/patients/:id/allergies', can('clinical.view', 'prescription.write'), async (req, res) => res.json(await clinical.listAllergies(id(req))));
r.post('/clinical/patients/:id/allergies', can('clinical.allergies'), async (req, res) => res.status(201).json(await clinical.addAllergy(id(req), req.body, req.ctx)));
r.post('/clinical/allergies/:id/deactivate', can('clinical.allergies'), async (req, res) => res.json(await clinical.deactivateAllergy(id(req), req.body, req.ctx)));

// Sinais vitais
r.get('/clinical/appointments/:id/vitals', can('clinical.view'), async (req, res) => res.json(await clinical.listVitals(id(req))));
r.post('/clinical/appointments/:id/vitals', can('nursing.vitals'), async (req, res) => res.status(201).json(await clinical.addVitals(id(req), req.body, req.ctx)));

// Evoluções / anotações (permissão por tipo verificada no serviço)
r.get('/clinical/appointments/:id/notes', can('clinical.view'), async (req, res) => res.json(await clinical.listNotes(id(req))));
r.post('/clinical/appointments/:id/notes', can('clinical.notes_medical', 'nursing.notes'), async (req, res) => res.status(201).json(await clinical.addNote(id(req), req.body, req.ctx)));

// Classificação de risco
r.get('/clinical/triage', can('triage.perform', 'clinical.view'), async (req, res) => res.json(await clinical.triageQueue()));
r.post('/clinical/triage', can('triage.perform'), async (req, res) => res.status(201).json(await clinical.createTriage(req.body, req.ctx)));
r.post('/clinical/triage/:id/status', can('triage.perform', 'clinical.notes_medical'), async (req, res) => res.json(await clinical.setTriageStatus(id(req), req.body.status, req.ctx)));

// Leitos
r.get('/clinical/beds', can('beds.view'), async (req, res) => res.json(await clinical.bedMap()));
r.post('/clinical/beds/admit', can('beds.manage'), async (req, res) => res.json(await clinical.admit(req.body, req.ctx)));
r.post('/clinical/beds/transfer', can('beds.manage'), async (req, res) => res.json(await clinical.transfer(req.body, req.ctx)));
r.post('/clinical/beds/discharge', can('beds.manage'), async (req, res) => res.json(await clinical.discharge(req.body, req.ctx)));
r.post('/clinical/beds/:id/status', can('beds.manage'), async (req, res) => res.json(await clinical.setBedStatus(id(req), req.body, req.ctx)));
r.get('/clinical/appointments/:id/movements', can('beds.view', 'clinical.view'), async (req, res) => res.json(await clinical.movements(id(req))));

// Prescrição
r.get('/clinical/appointments/:id/prescriptions', can('clinical.view'), async (req, res) => res.json(await rx.list(id(req))));
r.post('/clinical/appointments/:id/prescriptions', can('prescription.write'), async (req, res) => res.status(201).json(await rx.create(id(req), req.body, req.ctx)));
r.post('/clinical/prescriptions/:id/suspend', can('prescription.write'), async (req, res) => res.json(await rx.suspendPrescription(id(req), req.body, req.ctx)));
r.post('/clinical/prescription-items/:id/suspend', can('prescription.write'), async (req, res) => res.json(await rx.suspendItem(id(req), req.body, req.ctx)));

// Checagem / aprazamento
r.get('/clinical/schedule', can('clinical.view'), async (req, res) => res.json(await rx.schedule(req.query)));
r.post('/clinical/administrations/:id/check', can('nursing.administer'), async (req, res) => res.json(await rx.check(id(req), req.body, req.ctx)));
r.post('/clinical/prescription-items/:id/administer', can('nursing.administer'), async (req, res) => res.status(201).json(await rx.administerIfNeeded(id(req), req.body, req.ctx)));

// Enfermagem
r.get('/nursing/definitions', can('clinical.view'), (req, res) => res.json(nursing.scaleDefinitions()));
r.get('/nursing/appointments/:id/scales', can('clinical.view'), async (req, res) => res.json(await nursing.listScales(id(req))));
r.post('/nursing/appointments/:id/scales', can('nursing.scales'), async (req, res) => res.status(201).json(await nursing.addScale(id(req), req.body, req.ctx)));
r.get('/nursing/appointments/:id/care-plan', can('clinical.view'), async (req, res) => res.json(await nursing.getCarePlan(id(req))));
r.post('/nursing/appointments/:id/care-plan', can('nursing.sae'), async (req, res) => res.status(201).json(await nursing.saveCarePlan(id(req), req.body, req.ctx)));
r.get('/nursing/appointments/:id/fluids', can('clinical.view'), async (req, res) => res.json(await nursing.fluidSummary(id(req), req.query)));
r.post('/nursing/appointments/:id/fluids', can('nursing.fluids'), async (req, res) => res.status(201).json(await nursing.addFluid(id(req), req.body, req.ctx)));
r.get('/nursing/handoffs', can('clinical.view'), async (req, res) => res.json(await nursing.listHandoffs(req.query)));
r.post('/nursing/appointments/:id/handoffs', can('nursing.handoff'), async (req, res) => res.status(201).json(await nursing.addHandoff(id(req), req.body, req.ctx)));

module.exports = r;
