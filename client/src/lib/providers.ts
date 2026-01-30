/**
 * Provider Data Types and Hardcoded Provider List
 *
 * This file contains the provider capability data from the Provider Skills Spreadsheet.
 * For v1, this data is hardcoded. Future versions may load dynamically.
 */

// Specialty types that map to spreadsheet columns
export type Specialty =
  | "anger_issues"
  | "anxiety"
  | "couples"
  | "depression"
  | "family"
  | "grief"
  | "trauma"
  | "stress_management";

// Age groups that map to spreadsheet sections
export type AgeGroup = "adults" | "adolescents" | "children_6_11" | "children_0_5";

// Capability level for a specialty
export type CapabilityLevel = "full" | "slow" | "none";

// Provider location codes (3 TFC locations)
// Note: "Corp" (Corporate) is treated as ABQ
export type ProviderLocation = "ABQ" | "LL" | "RR";

// Specialty capability with level
export interface SpecialtyCapability {
  specialty: Specialty;
  level: CapabilityLevel;
}

// Age group capabilities
export interface AgeGroupCapabilities {
  ageGroup: AgeGroup;
  specialties: SpecialtyCapability[];
}

// Full provider profile
export interface Provider {
  name: string;
  credentials: string;
  location: ProviderLocation;
  acceptingNewPatients: boolean;
  ageGroups: AgeGroupCapabilities[];
  additionalSpecialties: string[]; // From Notes column (ADHD, EMDR, etc.)
}

// Helper to parse capability from spreadsheet value
function parseCapability(value: string | undefined): CapabilityLevel {
  if (!value || value.trim() === "") return "none";
  const lower = value.toLowerCase().trim();
  if (lower.includes("slow")) return "slow";
  if (lower === "x" || lower === "x ") return "full";
  return "none";
}

// Helper to parse name and credentials
function parseNameCredentials(fullName: string): { name: string; credentials: string } {
  const match = fullName.match(/^(.+?),?\s*([A-Z][-A-Za-z]+(?:\s*\([^)]+\))?)?\s*$/);
  if (match) {
    return {
      name: match[1].trim(),
      credentials: match[2]?.trim() || "",
    };
  }
  return { name: fullName.trim(), credentials: "" };
}

// Hardcoded provider data from CSV
export const PROVIDERS: Provider[] = [
  {
    name: "Amanda Davison",
    credentials: "LMFT",
    location: "ABQ", // Was "Corp" but Corp is mapped to ABQ
    acceptingNewPatients: false,
    ageGroups: [
      {
        ageGroup: "adults",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "couples", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "full" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
          { specialty: "stress_management", level: "full" },
        ],
      },
      {
        ageGroup: "adolescents",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "full" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
          { specialty: "stress_management", level: "full" },
        ],
      },
    ],
    additionalSpecialties: ["Bi-polar", "Conduct Behavioral", "Personality Disorder", "Substance abuse", "Christian Counseling", "Eating Disorders", "Neurodevelopmental", "RTM", "ADHD", "Military Life"],
  },
  {
    name: "Sandra Rivera",
    credentials: "LMFT",
    location: "ABQ",
    acceptingNewPatients: true,
    ageGroups: [
      {
        ageGroup: "adults",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "couples", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "full" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
          { specialty: "stress_management", level: "full" },
        ],
      },
      {
        ageGroup: "adolescents",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "full" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
          { specialty: "stress_management", level: "full" },
        ],
      },
      {
        ageGroup: "children_6_11",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "none" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "none" },
          { specialty: "stress_management", level: "none" },
        ],
      },
    ],
    additionalSpecialties: ["Bipolar", "EMDR", "Conduct behavioral", "Personality disorder", "Substance abuse", "Christian Counseling", "Eating Disorders", "Neurodevelopmental", "RTM", "ADHD", "Military Life"],
  },
  {
    name: "Jennifer Bogart",
    credentials: "LPCC",
    location: "ABQ",
    acceptingNewPatients: true,
    ageGroups: [
      {
        ageGroup: "adults",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "couples", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "full" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
          { specialty: "stress_management", level: "full" },
        ],
      },
      {
        ageGroup: "adolescents",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "full" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
          { specialty: "stress_management", level: "full" },
        ],
      },
      {
        ageGroup: "children_6_11",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "full" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
          { specialty: "stress_management", level: "full" },
        ],
      },
      {
        ageGroup: "children_0_5",
        specialties: [
          { specialty: "anxiety", level: "none" },
          { specialty: "depression", level: "none" },
          { specialty: "family", level: "none" },
          { specialty: "grief", level: "none" },
          { specialty: "trauma", level: "none" },
        ],
      },
    ],
    additionalSpecialties: ["Bi-polar", "Conduct behavioral", "Personality disorder", "Christian Counseling", "Substance Use", "Eating Disorder", "Neurodevelopmental", "Complex Medical", "RTM", "ADHD", "Military life"],
  },
  {
    name: "Anna Aldridge",
    credentials: "T-LMHC",
    location: "ABQ",
    acceptingNewPatients: true,
    ageGroups: [
      {
        ageGroup: "adults",
        specialties: [
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
          { specialty: "stress_management", level: "full" },
        ],
      },
      {
        ageGroup: "adolescents",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "family", level: "full" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
        ],
      },
      {
        ageGroup: "children_6_11",
        specialties: [
          { specialty: "anger_issues", level: "slow" },
          { specialty: "anxiety", level: "slow" },
          { specialty: "family", level: "slow" },
          { specialty: "grief", level: "slow" },
          { specialty: "trauma", level: "slow" },
        ],
      },
    ],
    additionalSpecialties: ["ADHD"],
  },
  {
    name: "Bentley Carbone",
    credentials: "Intern",
    location: "ABQ",
    acceptingNewPatients: true,
    ageGroups: [
      {
        ageGroup: "adults",
        specialties: [
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "slow" },
          { specialty: "grief", level: "slow" },
          { specialty: "trauma", level: "slow" },
          { specialty: "stress_management", level: "full" },
        ],
      },
      {
        ageGroup: "adolescents",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "slow" },
          { specialty: "family", level: "slow" },
          { specialty: "grief", level: "slow" },
          { specialty: "trauma", level: "full" },
        ],
      },
      {
        ageGroup: "children_6_11",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "slow" },
        ],
      },
      {
        ageGroup: "children_0_5",
        specialties: [
          { specialty: "anxiety", level: "slow" },
        ],
      },
    ],
    additionalSpecialties: ["ADHD"],
  },
  {
    name: "Angelica Chavez",
    credentials: "",
    location: "ABQ",
    acceptingNewPatients: true,
    ageGroups: [
      {
        ageGroup: "adults",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "couples", level: "slow" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "slow" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
          { specialty: "stress_management", level: "full" },
        ],
      },
      {
        ageGroup: "adolescents",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "slow" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
          { specialty: "stress_management", level: "full" },
        ],
      },
      {
        ageGroup: "children_6_11",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "slow" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
          { specialty: "stress_management", level: "full" },
        ],
      },
    ],
    additionalSpecialties: ["Christian Counseling", "RTM", "ADHD"],
  },
  {
    name: "Kennedy Hull",
    credentials: "LMHC",
    location: "ABQ",
    acceptingNewPatients: true,
    ageGroups: [
      {
        ageGroup: "adults",
        specialties: [
          { specialty: "anger_issues", level: "slow" },
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
          { specialty: "stress_management", level: "full" },
        ],
      },
      {
        ageGroup: "adolescents",
        specialties: [
          { specialty: "anger_issues", level: "slow" },
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
          { specialty: "stress_management", level: "full" },
        ],
      },
      {
        ageGroup: "children_6_11",
        specialties: [
          { specialty: "anxiety", level: "slow" },
          { specialty: "depression", level: "slow" },
          { specialty: "family", level: "slow" },
          { specialty: "grief", level: "slow" },
          { specialty: "trauma", level: "slow" },
        ],
      },
    ],
    additionalSpecialties: ["Bi-polar", "Conduct behavioral", "Neurodevelopmental", "ADHD"],
  },
  {
    name: "Debra Dederich-Elsner",
    credentials: "LPCC",
    location: "LL",
    acceptingNewPatients: true,
    ageGroups: [
      {
        ageGroup: "adults",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "couples", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "full" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
          { specialty: "stress_management", level: "full" },
        ],
      },
      {
        ageGroup: "adolescents",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "full" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
          { specialty: "stress_management", level: "full" },
        ],
      },
      {
        ageGroup: "children_6_11",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "full" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
          { specialty: "stress_management", level: "full" },
        ],
      },
    ],
    additionalSpecialties: ["Bi-polar", "Conduct behavioral", "Personality disorder", "Substance abuse", "Christian Counseling", "Neurodevelopmental", "RTM", "ADHD"],
  },
  {
    name: "Liz Lopez",
    credentials: "LMSW",
    location: "LL",
    acceptingNewPatients: true,
    ageGroups: [
      {
        ageGroup: "adults",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "couples", level: "slow" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "slow" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
          { specialty: "stress_management", level: "full" },
        ],
      },
      {
        ageGroup: "adolescents",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "slow" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
          { specialty: "stress_management", level: "full" },
        ],
      },
      {
        ageGroup: "children_6_11",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "slow" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
          { specialty: "stress_management", level: "full" },
        ],
      },
    ],
    additionalSpecialties: ["Bi-polar", "Conduct behavioral", "Substance abuse", "Eating disorder", "Neurodevelopmental", "RTM", "ADHD", "Military Life", "LGBTQ", "Spiritual"],
  },
  {
    name: "Carrie Savedra",
    credentials: "LMSW",
    location: "LL",
    acceptingNewPatients: true,
    ageGroups: [],
    additionalSpecialties: ["Christian Counseling", "ADHD"],
  },
  {
    name: "Amber Lute",
    credentials: "T-AMFT",
    location: "LL",
    acceptingNewPatients: true,
    ageGroups: [
      {
        ageGroup: "adults",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "couples", level: "slow" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "slow" },
          { specialty: "grief", level: "slow" },
          { specialty: "trauma", level: "slow" },
          { specialty: "stress_management", level: "full" },
        ],
      },
      {
        ageGroup: "adolescents",
        specialties: [
          { specialty: "anger_issues", level: "slow" },
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "slow" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "slow" },
          { specialty: "stress_management", level: "full" },
        ],
      },
      {
        ageGroup: "children_6_11",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "slow" },
          { specialty: "grief", level: "slow" },
          { specialty: "trauma", level: "full" },
          { specialty: "stress_management", level: "full" },
        ],
      },
      {
        ageGroup: "children_0_5",
        specialties: [
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "full" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
        ],
      },
    ],
    additionalSpecialties: ["IMH", "Conduct behavioral", "Neurodevelopmental", "ADHD", "Military Life"],
  },
  {
    name: "Paula Raley",
    credentials: "LCSW",
    location: "LL",
    acceptingNewPatients: true,
    ageGroups: [
      {
        ageGroup: "adults",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "couples", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "full" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
          { specialty: "stress_management", level: "full" },
        ],
      },
      {
        ageGroup: "adolescents",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "full" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
          { specialty: "stress_management", level: "full" },
        ],
      },
      {
        ageGroup: "children_6_11",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "full" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
          { specialty: "stress_management", level: "full" },
        ],
      },
      {
        ageGroup: "children_0_5",
        specialties: [
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "full" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
        ],
      },
    ],
    additionalSpecialties: ["Bi-polar", "Conduct behavioral", "Personality disorder", "Substance abuse", "Christian Counseling", "RTM", "ADHD", "IMH", "Military Life"],
  },
  {
    name: "Kylah Guerra",
    credentials: "Intern",
    location: "LL",
    acceptingNewPatients: true,
    ageGroups: [],
    additionalSpecialties: [],
  },
  {
    name: "Jill Nantze",
    credentials: "LAMFT",
    location: "LL",
    acceptingNewPatients: true,
    ageGroups: [
      {
        ageGroup: "adults",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
          { specialty: "stress_management", level: "full" },
        ],
      },
      {
        ageGroup: "adolescents",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
          { specialty: "stress_management", level: "full" },
        ],
      },
      {
        ageGroup: "children_6_11",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
        ],
      },
    ],
    additionalSpecialties: [],
  },
  {
    name: "Angelica Villicana",
    credentials: "LCSW",
    location: "RR",
    acceptingNewPatients: true,
    ageGroups: [
      {
        ageGroup: "adults",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "couples", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "full" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
          { specialty: "stress_management", level: "full" },
        ],
      },
      {
        ageGroup: "adolescents",
        specialties: [
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "full" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
          { specialty: "stress_management", level: "full" },
        ],
      },
      {
        ageGroup: "children_6_11",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "full" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
          { specialty: "stress_management", level: "full" },
        ],
      },
      {
        ageGroup: "children_0_5",
        specialties: [
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "full" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
        ],
      },
    ],
    additionalSpecialties: ["Christian Counseling", "EMDR", "Bi-polar", "Conduct behavioral", "Substance abuse", "Neurodevelopmental", "RTM", "ADHD", "Military Life", "Spanish"],
  },
  {
    name: "Amber Merritt",
    credentials: "LCSW",
    location: "RR",
    acceptingNewPatients: true,
    ageGroups: [
      {
        ageGroup: "adults",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "couples", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "full" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
          { specialty: "stress_management", level: "full" },
        ],
      },
      {
        ageGroup: "adolescents",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "full" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
          { specialty: "stress_management", level: "full" },
        ],
      },
      {
        ageGroup: "children_6_11",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "full" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
          { specialty: "stress_management", level: "full" },
        ],
      },
      {
        ageGroup: "children_0_5",
        specialties: [
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "full" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
        ],
      },
    ],
    additionalSpecialties: ["IMH", "RTM", "ADHD"],
  },
  {
    name: "Danielle Burke",
    credentials: "LPCC",
    location: "RR",
    acceptingNewPatients: true,
    ageGroups: [
      {
        ageGroup: "adults",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
          { specialty: "stress_management", level: "full" },
        ],
      },
      {
        ageGroup: "adolescents",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
          { specialty: "stress_management", level: "full" },
        ],
      },
      {
        ageGroup: "children_6_11",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "full" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
          { specialty: "stress_management", level: "full" },
        ],
      },
    ],
    additionalSpecialties: ["Christian Counseling", "IMH", "Bi-polar", "Conduct behavioral", "Substance abuse", "Eating disorder", "Neurodevelopmental", "ADHD"],
  },
  {
    name: "Abena Marfowaa Owusu-Nkwantabisah",
    credentials: "T-LMHC",
    location: "RR",
    acceptingNewPatients: true,
    ageGroups: [
      {
        ageGroup: "adults",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "couples", level: "slow" },
          { specialty: "depression", level: "full" },
          { specialty: "stress_management", level: "full" },
        ],
      },
      {
        ageGroup: "adolescents",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "full" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
        ],
      },
    ],
    additionalSpecialties: ["Conduct behavioral", "Substance abuse", "Christian Counseling", "RTM", "EMDR", "Military life", "Russian"],
  },
  {
    name: "Jennifer Freer",
    credentials: "LCSW",
    location: "RR",
    acceptingNewPatients: true,
    ageGroups: [
      {
        ageGroup: "adults",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "slow" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
          { specialty: "stress_management", level: "full" },
        ],
      },
      {
        ageGroup: "adolescents",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "slow" },
          { specialty: "family", level: "full" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
          { specialty: "stress_management", level: "slow" },
        ],
      },
      {
        ageGroup: "children_6_11",
        specialties: [
          { specialty: "anger_issues", level: "slow" },
          { specialty: "anxiety", level: "slow" },
          { specialty: "depression", level: "slow" },
          { specialty: "family", level: "slow" },
          { specialty: "grief", level: "slow" },
          { specialty: "trauma", level: "slow" },
          { specialty: "stress_management", level: "slow" },
        ],
      },
      {
        ageGroup: "children_0_5",
        specialties: [
          { specialty: "anxiety", level: "slow" },
          { specialty: "depression", level: "slow" },
          { specialty: "family", level: "slow" },
          { specialty: "grief", level: "slow" },
          { specialty: "trauma", level: "slow" },
        ],
      },
    ],
    additionalSpecialties: ["EMDR", "Gay/Lesbian", "Gender Identity", "Grief", "Mood", "Parenting", "PTSD", "Trauma Focused"],
  },
  {
    name: "Renee Singletary",
    credentials: "LMSW",
    location: "RR",
    acceptingNewPatients: true,
    ageGroups: [
      {
        ageGroup: "adults",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "couples", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "full" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
          { specialty: "stress_management", level: "full" },
        ],
      },
      {
        ageGroup: "adolescents",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "full" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
          { specialty: "stress_management", level: "full" },
        ],
      },
      {
        ageGroup: "children_6_11",
        specialties: [
          { specialty: "anger_issues", level: "full" },
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "full" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
          { specialty: "stress_management", level: "full" },
        ],
      },
      {
        ageGroup: "children_0_5",
        specialties: [
          { specialty: "anxiety", level: "full" },
          { specialty: "depression", level: "full" },
          { specialty: "family", level: "full" },
          { specialty: "grief", level: "full" },
          { specialty: "trauma", level: "full" },
        ],
      },
    ],
    additionalSpecialties: ["LGBTQ", "Conduct Disorder", "Christian Counseling", "Bi-polar", "Personality Disorder", "Substance abuse", "Eating disorders", "Neurodevelopmental", "RTM", "ADHD", "Military life", "Spanish"],
  },
];

// Location label mapping (3 TFC locations)
export const LOCATION_LABELS: Record<ProviderLocation, string> = {
  ABQ: "Albuquerque",
  LL: "Los Lunas",
  RR: "Rio Rancho",
};

// Age group label mapping
export const AGE_GROUP_LABELS: Record<AgeGroup, string> = {
  adults: "Adults (18+)",
  adolescents: "Adolescents (12-17)",
  children_6_11: "Children (6-11)",
  children_0_5: "Children (0-5)",
};

// Specialty label mapping
export const SPECIALTY_LABELS: Record<Specialty, string> = {
  anger_issues: "Anger Issues",
  anxiety: "Anxiety",
  couples: "Couples",
  depression: "Depression",
  family: "Family",
  grief: "Grief",
  trauma: "Trauma",
  stress_management: "Stress Management",
};
