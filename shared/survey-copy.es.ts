/**
 * Client survey — every client-facing string, in English and Spanish.
 * ============================================================================
 *
 * HOW TO APPLY A CORRECTION: find the English line the client is commenting on,
 * and replace the `es:` line directly beneath it. Nothing else in this file, or
 * anywhere else, needs to change. Keep the quotation marks and the trailing
 * comma. Words in {braces} are filled in by the form (a number, a count) and
 * must stay exactly as they are, braces included.
 *
 * WHAT THIS FILE IS NOT. It is DISPLAY copy only. What a client's answer STORES
 * is never read from here: a Spanish-speaking client who taps "Sí" stores "Yes",
 * exactly as an English-speaking client does, so matching, the PDF, the Excel
 * export and every report read the same values whatever language the form was
 * shown in. The stored values and the question wording staff see live in
 * shared/survey-questions.ts, which this file does not change.
 *
 * THE `en:` LINES. For the questions, answer options and scale anchors, the
 * English is owned by shared/survey-questions.ts (the practice's verbatim
 * TherapyNotes wording, typos included) and the form renders it from there. The
 * `en:` lines in those sections are a copy for the translator to read against,
 * and scripts/test-survey-fields.ts fails if one ever stops matching the
 * original — so a change to the English wording cannot quietly leave a stale
 * Spanish line behind. For everything else (screen titles, buttons, messages,
 * the confirmation) the `en:` line here IS the English the form shows.
 *
 * THE SPANISH does not reproduce the English source's typos ("We're you
 * greeted", "an technical difficulties"); it is written as correct Spanish.
 *
 * Neutral Latin American Spanish, formal "usted". First-pass translation,
 * 2026-09-28, pending the client's review.
 *
 * IMPORTS: types only. This module is compiled into the PUBLIC survey bundle,
 * so it may not import anything that carries staff data.
 */

import type { SurveyModality, SurveyVariant } from "./survey-questions";

/** One string, both languages. */
export interface Copy {
  en: string;
  es: string;
}

// ============================================================================
// Questions, keyed by question key (the stored answer key — never rename one)
// ============================================================================

/** Questions worded identically on both forms. */
const SHARED_QUESTIONS: Record<string, Copy> = {
  therapist: {
    en: "Please select the treating therapist's name",
    es: "Por favor, seleccione el nombre de su terapeuta",
  },
  goalsRating: {
    en: "On a scale of 0-10, how would you rate your goals and topics for session?",
    es: "En una escala del 0 al 10, ¿cómo calificaría los objetivos y temas de su sesión?",
  },
  approachRating: {
    en: "On a scale of 0-10, how would you rate your therapist's approach or methods?",
    es: "En una escala del 0 al 10, ¿cómo calificaría el enfoque o los métodos de su terapeuta?",
  },
  overallRating: {
    en: "On a scale of 0-10, how would you rate your session overall?",
    es: "En una escala del 0 al 10, ¿cómo calificaría su sesión en general?",
  },
  followUpRequested: {
    en: "Would you like our team to follow up with you regarding your survey?",
    es: "¿Desea que nuestro equipo se comunique con usted sobre su encuesta?",
  },
  additionalComments: {
    en: "Additional Comments",
    es: "Comentarios adicionales",
  },
};

/** The in-person form's own wording. Checked before SHARED_QUESTIONS. */
const IN_PERSON_QUESTIONS: Record<string, Copy> = {
  facilityClean: {
    en: "Was the facility clean and inviting?",
    es: "¿Las instalaciones estaban limpias y eran acogedoras?",
  },
  greetedOnArrival: {
    en: "We're you greeted upon arrival?",
    es: "¿Le dieron la bienvenida al llegar?",
  },
  seenWithinTenMinutes: {
    en: "Were you called back to a room within 10 minutes of your scheduled appointment time?",
    es: "¿Le llamaron para pasar al consultorio dentro de los 10 minutos siguientes a la hora de su cita?",
  },
  privacyRespected: {
    en: "Did you feel your privacy was respected?",
    es: "¿Sintió que se respetó su privacidad?",
  },
  endedFeelingValued: {
    en: "Did you end session feeling like you are of value to us?",
    es: "Al terminar la sesión, ¿sintió que usted es importante para nosotros?",
  },
  connectionRating: {
    en: "On a scale of 0-10 how would you rate your connection with your therapist?",
    es: "En una escala del 0 al 10, ¿cómo calificaría su conexión con su terapeuta?",
  },
};

/** The telehealth form's own wording. Checked before SHARED_QUESTIONS. */
const TELEHEALTH_QUESTIONS: Record<string, Copy> = {
  platformSatisfaction: {
    en: "How satisfied were you with the Telehealth platform or telephone for your session?",
    es: "¿Qué tan satisfactoria fue la plataforma de telesalud o el teléfono que usó para su sesión?",
  },
  techDifficultyResponse: {
    en: "If you had an technical difficulties, did you receive a prompt call from your provider to resolve the issue?",
    es: "Si tuvo alguna dificultad técnica, ¿recibió una llamada rápida de su proveedor para resolver el problema?",
  },
  seenWithinTenMinutes: {
    en: "Were you called within 10 minutes of your appointment time to begin your session?",
    es: "¿Le llamaron dentro de los 10 minutos siguientes a la hora de su cita para comenzar su sesión?",
  },
  privacyRespected: {
    en: "Did you feel your privacy was respected in this treatment format?",
    es: "¿Sintió que se respetó su privacidad en este formato de tratamiento?",
  },
  endedFeelingValued: {
    en: "Did you end session feeling like you are a value to us?",
    es: "Al terminar la sesión, ¿sintió que usted es importante para nosotros?",
  },
  connectionRating: {
    en: "On a scale of 0-10, how would you rate your connection with your therapist?",
    es: "En una escala del 0 al 10, ¿cómo calificaría su conexión con su terapeuta?",
  },
};

export const QUESTION_COPY: {
  shared: Record<string, Copy>;
  byVariant: Record<SurveyVariant, Record<string, Copy>>;
} = {
  shared: SHARED_QUESTIONS,
  byVariant: { "in-person": IN_PERSON_QUESTIONS, telehealth: TELEHEALTH_QUESTIONS },
};

// ============================================================================
// The words under the 0 and the 10 on each rating question
// ============================================================================

export const ANCHOR_COPY: Record<string, { low: Copy; high: Copy }> = {
  connectionRating: {
    low: {
      en: "0-Not being heard, understood or respected",
      es: "0-No sentí que me escucharan, comprendieran ni respetaran",
    },
    high: {
      en: "10- Felt heard, understood, and respected",
      es: "10- Sentí que me escucharon, comprendieron y respetaron",
    },
  },
  goalsRating: {
    low: {
      en: "0-Did not work or talk about goals",
      es: "0-No trabajamos ni hablamos sobre mis objetivos",
    },
    high: {
      en: "10-Worked or talked about goals",
      es: "10-Trabajamos o hablamos sobre mis objetivos",
    },
  },
  approachRating: {
    low: {
      en: "0- The approach is not a good fit for me",
      es: "0- El enfoque no es adecuado para mí",
    },
    high: {
      en: "10-The approach is a good fit for me",
      es: "10-El enfoque es adecuado para mí",
    },
  },
  overallRating: {
    low: {
      en: "0- There was something missing in session",
      es: "0- Faltó algo en la sesión",
    },
    high: {
      en: "10- Overall session was right for me",
      es: "10- En general, la sesión fue adecuada para mí",
    },
  },
};

// ============================================================================
// Answer options. The `en:` value is what gets STORED; only the label changes.
// ============================================================================

export const OPTION_COPY: Record<string, Copy> = {
  Excellent: { en: "Excellent", es: "Excelente" },
  Satisfied: { en: "Satisfied", es: "Satisfecho(a)" },
  Neutral: { en: "Neutral", es: "Neutral" },
  "Could be better": { en: "Could be better", es: "Podría mejorar" },
  "Needs improvement immediately": {
    en: "Needs improvement immediately",
    es: "Necesita mejorar de inmediato",
  },
  Yes: { en: "Yes", es: "Sí" },
  No: { en: "No", es: "No" },
  "N/A": { en: "N/A", es: "No aplica" },
};

/** The label under the logo naming which form this is. */
export const MODALITY_COPY: Record<SurveyModality, Copy> = {
  "In Person": { en: "In Person", es: "En persona" },
  Telehealth: { en: "Telehealth", es: "Telesalud" },
};

// ============================================================================
// Screens, fields and buttons
// ============================================================================

export const UI_COPY = {
  pageTitle: {
    en: "Client Survey — The Family Connection",
    es: "Encuesta para clientes — The Family Connection",
  },
  languageSwitchLabel: { en: "Language", es: "Idioma" },

  // --- Step 1: identity ---
  identityTitle: { en: "First, who are you?", es: "Primero, ¿quién es usted?" },
  identityDescription: {
    en: "So we can connect your feedback to your record. We only use it for that.",
    es: "Así podemos vincular sus comentarios con su expediente. Solo usamos estos datos para eso.",
  },
  privacyNote: {
    en: "Your answers go to The Family Connection’s care team. They are not shared outside the practice.",
    es: "Sus respuestas van al equipo de atención de The Family Connection. No se comparten fuera de la clínica.",
  },
  legalNameLabel: { en: "Your legal name", es: "Su nombre legal" },
  legalNameHint: {
    en: "Please use your legal name, not a preferred or shortened name, so we can find your record.",
    es: "Por favor, use su nombre legal, no un nombre preferido ni abreviado, para que podamos encontrar su expediente.",
  },
  dateOfBirthLabel: { en: "Date of birth", es: "Fecha de nacimiento" },
  emailLabel: { en: "Email address", es: "Correo electrónico" },
  phoneLabel: { en: "Phone number", es: "Número de teléfono" },

  // --- Step 2: therapist ---
  therapistTitle: { en: "Who did you see?", es: "¿Con quién tuvo su sesión?" },
  therapistLoading: {
    en: "Loading the list of therapists…",
    es: "Cargando la lista de terapeutas…",
  },
  therapistDegraded: {
    en: "We could not load the list of therapists just now. Please reload the page, or contact the office and we will take your feedback directly.",
    es: "No pudimos cargar la lista de terapeutas en este momento. Por favor, vuelva a cargar la página o comuníquese con la oficina y tomaremos sus comentarios directamente.",
  },
  therapistNone: {
    en: "No therapists are listed at the moment. Please contact the office and we will take your feedback directly.",
    es: "En este momento no hay terapeutas en la lista. Por favor, comuníquese con la oficina y tomaremos sus comentarios directamente.",
  },
  therapistSearchPlaceholder: {
    en: "Start typing a name…",
    es: "Empiece a escribir un nombre…",
  },
  therapistNoMatch: {
    en: "No therapist matches that name.",
    es: "Ningún terapeuta coincide con ese nombre.",
  },
  therapistShownCount: {
    en: "{shown} of {total} shown",
    es: "Se muestran {shown} de {total}",
  },
  therapistTotalCount: { en: "{total} therapists", es: "{total} terapeutas" },

  // --- Steps 3 to 7: titles and the line under them ---
  screen3Title: { en: "Getting started", es: "Para comenzar" },
  screen4Title: { en: "Your time and privacy", es: "Su tiempo y su privacidad" },
  screen5Title: { en: "You and your therapist", es: "Usted y su terapeuta" },
  screen5Description: {
    en: "Zero to ten, whatever feels right.",
    es: "Del cero al diez, lo que a usted le parezca.",
  },
  screen6Title: { en: "Approach and overall", es: "Enfoque y evaluación general" },
  screen6Description: {
    en: "Two more, then you are done.",
    es: "Dos preguntas más y habrá terminado.",
  },
  screen7Title: { en: "Anything else", es: "Algo más" },

  // --- Parts of every question ---
  commentPrompt: {
    en: "Anything you would like to add?",
    es: "¿Hay algo que desee agregar?",
  },
  optional: { en: "Optional", es: "Opcional" },
  charactersLeft: { en: "{remaining} characters left", es: "Quedan {remaining} caracteres" },
  /** Read aloud by a screen reader on each 0-10 button. */
  scaleButtonLabel: { en: "{n} out of 10", es: "{n} de 10" },

  // --- Progress and buttons ---
  stepCounter: { en: "Step {step} of {total}", es: "Paso {step} de {total}" },
  progressLabel: { en: "Survey progress", es: "Progreso de la encuesta" },
  back: { en: "Back", es: "Atrás" },
  continue: { en: "Continue", es: "Continuar" },
  submit: { en: "Submit", es: "Enviar" },
  sending: { en: "Sending…", es: "Enviando…" },
  footer: {
    en: "The Family Connection · Albuquerque, New Mexico",
    es: "The Family Connection · Albuquerque, Nuevo México",
  },

  // --- The page shown for a link that names no form ---
  unknownLinkTitle: {
    en: "This link doesn’t look right",
    es: "Este enlace no parece correcto",
  },
  unknownLinkBody: {
    en: "Please check the link from your email, or scan the code again. If it still doesn’t work, contact the office and we will take your feedback directly.",
    es: "Por favor, revise el enlace de su correo electrónico o vuelva a escanear el código. Si aún no funciona, comuníquese con la oficina y tomaremos sus comentarios directamente.",
  },
} satisfies Record<string, Copy>;

export type UiKey = keyof typeof UI_COPY;

// ============================================================================
// Error messages
//
// Keyed by the EXACT English the form's checks and the server produce, so a
// message is translated where it is shown without the server needing to know
// the language. A message missing from this list is shown in English rather
// than not at all; scripts/test-survey-fields.ts fails if any is missing.
// ============================================================================

export const MESSAGE_COPY: Record<string, string> = {
  // Checked on the form as the client types (step 1)
  "Please enter your legal name.": "Por favor, escriba su nombre legal.",
  "Please shorten that name.": "Por favor, acorte ese nombre.",
  "Please enter your date of birth.": "Por favor, escriba su fecha de nacimiento.",
  "Please enter your date of birth as a real date.":
    "Por favor, escriba una fecha de nacimiento válida.",
  "That date is in the future. Please check it.":
    "Esa fecha es posterior a hoy. Por favor, revísela.",
  "Please check the year on that date.": "Por favor, revise el año de esa fecha.",
  "Please enter your email address.": "Por favor, escriba su correo electrónico.",
  "Please check that email address.": "Por favor, revise ese correo electrónico.",
  "Please enter your phone number.": "Por favor, escriba su número de teléfono.",
  "Please enter a phone number with at least 10 digits.":
    "Por favor, escriba un número de teléfono de al menos 10 dígitos.",
  "Please check that phone number.": "Por favor, revise ese número de teléfono.",

  // Sent back by the server when a submission is refused
  "Unknown form": "Formulario desconocido.",
  "That response is too long to submit.": "Esa respuesta es demasiado larga para enviarla.",
  "Some answers were missing or invalid. Please check the form.":
    "Faltan algunas respuestas o no son válidas. Por favor, revise el formulario.",
  "That was submitted too quickly. Please try again.":
    "Se envió demasiado rápido. Por favor, inténtelo de nuevo.",
  "This form has been open too long. Please reload and start again.":
    "Este formulario ha estado abierto demasiado tiempo. Por favor, vuelva a cargar la página y comience de nuevo.",
  "We have received a lot of responses from this network. Please try again later.":
    "Hemos recibido muchas respuestas desde esta red. Por favor, inténtelo más tarde.",
  "We could not save your response. Please try again.":
    "No pudimos guardar su respuesta. Por favor, inténtelo de nuevo.",
  "We could not save your response just now. Please try again.":
    "No pudimos guardar su respuesta en este momento. Por favor, inténtelo de nuevo.",
};

// ============================================================================
// Confirmation screen
//
// The English is the practice's own final copy (handed over 2026-09-12) and is
// verbatim; do not edit the `en:` lines. The Spanish is a plain equivalent.
// ============================================================================

export const CONFIRMATION_COPY = {
  title: {
    en: "Thank you — your feedback has been recorded!",
    es: "¡Gracias! Sus comentarios han quedado registrados.",
  },
  paragraph1: {
    en: "We truly appreciate you taking the time to share your experience with us. We read every response, and your feedback helps us learn, grow, and continue providing the best possible care and support to the individuals and families we serve.",
    es: "Le agradecemos sinceramente que se haya tomado el tiempo de compartir su experiencia con nosotros. Leemos cada respuesta, y sus comentarios nos ayudan a aprender, crecer y seguir brindando la mejor atención y el mejor apoyo posibles a las personas y familias que atendemos.",
  },
  paragraph2: {
    en: "Your voice matters and helps us continue making The Family Connection a place where clients feel heard, supported, and connected.",
    es: "Su opinión es importante y nos ayuda a que The Family Connection siga siendo un lugar donde los clientes se sientan escuchados, apoyados y conectados.",
  },
  paragraph3: {
    en: "If you requested a follow-up, a member of our team will reach out to you soon.",
    es: "Si solicitó un seguimiento, un miembro de nuestro equipo se comunicará con usted pronto.",
  },
  closingLine: {
    en: "Thank you for trusting The Family Connection to be part of your journey.",
    es: "Gracias por confiar en The Family Connection para acompañarle en su proceso.",
  },
  closePage: { en: "You may now close this page.", es: "Ya puede cerrar esta página." },
} satisfies Record<string, Copy>;
