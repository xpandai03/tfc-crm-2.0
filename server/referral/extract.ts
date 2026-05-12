import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { REFERRAL_EXTRACTION_PROMPT } from "./prompt";

const client = new BedrockRuntimeClient({
  region: process.env.AWS_REGION ?? "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

// Bedrock inference profile IDs (cross-region, us-east-1 fronted).
// Both require Bedrock model access + aws-marketplace:Subscribe on the IAM principal.
// Primary is Sonnet 4.5 for highest accuracy; fallback is Haiku 4.5 (faster/cheaper).
// The fallback triggers on AccessDenied / ValidationException / ResourceNotFound.
const PRIMARY_MODEL_ID = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
const FALLBACK_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0";

export interface ExtractedReferralData {
  firstName: string | null;
  lastName: string | null;
  dateOfBirth: string | null;
  phone: string | null;
  email: string | null;
  streetAddress: string | null;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  gender: string | null;
  reasonForSeeking: string | null;
  reasonForTherapy: string | null;
  diagnosis: string | null;
  insurancePayer: string | null;
  referralSource: string | null;
  referringProvider: string | null;
  referralAuth: string | null;
}

function buildPayload(base64Pdf: string): string {
  return JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 1024,
    system: REFERRAL_EXTRACTION_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: base64Pdf,
            },
          },
          {
            type: "text",
            text: "Extract the patient and referral data from this document and return the JSON object.",
          },
        ],
      },
    ],
  });
}

async function invoke(modelId: string, body: string): Promise<string> {
  const command = new InvokeModelCommand({
    modelId,
    contentType: "application/json",
    accept: "application/json",
    body,
  });
  const response = await client.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));
  return responseBody.content[0].text as string;
}

export async function extractReferralData(pdfBuffer: Buffer): Promise<ExtractedReferralData> {
  const startTime = Date.now();
  const base64Pdf = pdfBuffer.toString("base64");
  const body = buildPayload(base64Pdf);

  let rawText: string;
  try {
    rawText = await invoke(PRIMARY_MODEL_ID, body);
  } catch (err) {
    const msg = (err as Error).message || "";
    // Fall back only on model-access/availability errors, not on network/runtime errors
    if (/AccessDenied|ValidationException|ResourceNotFound|not found|don.t have access/i.test(msg)) {
      console.warn(`[referral/extract] Primary model ${PRIMARY_MODEL_ID} unavailable, falling back`);
      rawText = await invoke(FALLBACK_MODEL_ID, body);
    } else {
      throw err;
    }
  }

  // Strip markdown fences defensively — the prompt forbids them but models occasionally slip
  const cleaned = rawText
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();

  let parsed: ExtractedReferralData;
  try {
    parsed = JSON.parse(cleaned) as ExtractedReferralData;
  } catch (_err) {
    console.error(`[referral/extract] JSON parse failed after ${Date.now() - startTime}ms`);
    throw new Error("Extraction response was not valid JSON");
  }

  console.log(`[referral/extract] Success in ${Date.now() - startTime}ms — referralAuth: ${parsed.referralAuth ?? "none"}`);
  return parsed;
}
