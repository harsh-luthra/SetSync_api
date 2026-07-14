import fs from 'node:fs';
import path from 'node:path';
import puppeteer, { type Browser } from 'puppeteer';
import { logger } from '../config/logger';

export interface CallSheetSceneRow {
  sceneNumber: string;
  intExt: string;
  dayNight: string;
  locationName: string;
  synopsis: string;
  castNames: string;
}

export interface CallSheetActorRow {
  actorName: string;
  pickupTime: string;
  callTime: string;
  makeupTime: string;
  hairTime: string;
  onSetTime: string;
  scenes: string;
}

export interface CallSheetModel {
  projectTitle: string;
  productionHouse: string;
  dayNumber: number;
  dateLabel: string;
  generalCallTime: string;
  locationName: string;
  locationMapUrl?: string;
  generalNotes?: string;
  scenes: CallSheetSceneRow[];
  actorCalls: CallSheetActorRow[];
  emergencyContacts: { name: string; role: string; phone: string }[];
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let templateCache: string | null = null;

function loadTemplate(): string {
  if (!templateCache) {
    const templatePath = path.join(__dirname, '..', 'templates', 'callsheet.html');
    templateCache = fs.readFileSync(templatePath, 'utf8');
  }
  return templateCache;
}

function renderTemplate(model: CallSheetModel): string {
  const sceneRows = model.scenes
    .map(
      (s) => `<tr>
        <td class="num">${escapeHtml(s.sceneNumber)}</td>
        <td>${escapeHtml(s.intExt)}</td>
        <td>${escapeHtml(s.dayNight)}</td>
        <td>${escapeHtml(s.locationName)}</td>
        <td class="synopsis">${escapeHtml(s.synopsis)}</td>
        <td>${escapeHtml(s.castNames)}</td>
      </tr>`,
    )
    .join('\n');

  const actorRows = model.actorCalls
    .map(
      (a) => `<tr>
        <td class="name">${escapeHtml(a.actorName)}</td>
        <td>${escapeHtml(a.pickupTime)}</td>
        <td>${escapeHtml(a.callTime)}</td>
        <td>${escapeHtml(a.makeupTime)}</td>
        <td>${escapeHtml(a.hairTime)}</td>
        <td>${escapeHtml(a.onSetTime)}</td>
        <td>${escapeHtml(a.scenes)}</td>
      </tr>`,
    )
    .join('\n');

  const contacts = model.emergencyContacts
    .map(
      (c) =>
        `<span class="contact"><strong>${escapeHtml(c.name)}</strong> (${escapeHtml(c.role)}) — ${escapeHtml(c.phone)}</span>`,
    )
    .join(' &nbsp;•&nbsp; ');

  const mapLink = model.locationMapUrl
    ? `<a href="${escapeHtml(model.locationMapUrl)}">📍 Open map</a>`
    : '';

  const replacements: Record<string, string> = {
    PROJECT_TITLE: escapeHtml(model.projectTitle),
    PRODUCTION_HOUSE: escapeHtml(model.productionHouse),
    DAY_NUMBER: escapeHtml(model.dayNumber),
    DATE: escapeHtml(model.dateLabel),
    CALL_TIME: escapeHtml(model.generalCallTime),
    LOCATION: escapeHtml(model.locationName),
    MAP_LINK: mapLink,
    NOTES: escapeHtml(model.generalNotes || '—'),
    SCENE_ROWS: sceneRows || '<tr><td colspan="6">No scenes scheduled</td></tr>',
    ACTOR_ROWS: actorRows || '<tr><td colspan="7">No actor calls</td></tr>',
    EMERGENCY_CONTACTS: contacts || 'Production office',
    GENERATED_AT: escapeHtml(
      new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date()),
    ),
  };

  return loadTemplate().replace(/\{\{(\w+)\}\}/g, (_m, key: string) => replacements[key] ?? '');
}

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    browserPromise.catch(() => {
      browserPromise = null;
    });
  }
  return browserPromise;
}

/** Render the call sheet HTML template to an A4 PDF buffer. */
export async function generateCallSheetPdf(model: CallSheetModel): Promise<Buffer> {
  const html = renderTemplate(model);
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '12mm', bottom: '12mm', left: '10mm', right: '10mm' },
    });
    logger.info({ dayNumber: model.dayNumber }, 'Call sheet PDF generated');
    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => undefined);
  }
}
