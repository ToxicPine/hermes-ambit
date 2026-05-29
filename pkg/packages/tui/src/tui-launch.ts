import type { AppProfile } from "./app-profile.js";
import type { CommandRuntime } from "./command.js";
import {
  draftFromArgs,
  draftFromProfile,
  setSetupDraftField,
  type SetupDraft,
} from "./setup-state.js";
import type {
  AppError,
  CommandIntent,
  ProviderKind,
} from "./types.js";

export type TuiLaunchContext = {
  readonly profileName: string;
  readonly provider?: ProviderKind;
  readonly profile?: AppProfile;
  readonly profileError?: AppError;
  readonly setupDraft: SetupDraft;
};

const hasExplicitLaunchInput = (
  intent: Extract<CommandIntent, { readonly command: "tui" }>,
): boolean =>
  intent.globals.provider !== undefined ||
  intent.globals.deployment !== undefined ||
  Object.keys(intent.globals.providerFields).length > 0;

const draftFromIntent = (
  intent: Extract<CommandIntent, { readonly command: "tui" }>,
  profileName: string,
): SetupDraft =>
  draftFromArgs({
    profile: profileName,
    ...(intent.globals.provider ? { provider: intent.globals.provider } : {}),
    ...(intent.globals.deployment
      ? { deployment: intent.globals.deployment }
      : {}),
    fields: intent.globals.providerFields,
  });

const overlayIntentInput = (
  draft: SetupDraft,
  intent: Extract<CommandIntent, { readonly command: "tui" }>,
): SetupDraft => {
  let next = draft;
  if (intent.globals.provider) {
    next = setSetupDraftField(next, "provider", intent.globals.provider);
  }
  if (intent.globals.deployment) {
    next = setSetupDraftField(next, "deployment", intent.globals.deployment);
  }
  for (const [key, value] of Object.entries(intent.globals.providerFields)) {
    next = setSetupDraftField(next, key, value);
  }
  return next;
};

export const tuiLaunchContext = (
  intent: Extract<CommandIntent, { readonly command: "tui" }>,
  runtime: CommandRuntime,
): TuiLaunchContext => {
  const explicitLaunchInput = hasExplicitLaunchInput(intent);
  const useActiveProfile = !intent.globals.profile && !explicitLaunchInput;
  const activeName = runtime.profiles?.readActiveProfileName();
  const activeError =
    useActiveProfile && activeName && typeof activeName !== "string"
      ? activeName
      : undefined;
  const profileName =
    intent.globals.profile ??
    (useActiveProfile && typeof activeName === "string" ? activeName : "default");
  const directLaunchInput = explicitLaunchInput && !intent.globals.profile;

  if (directLaunchInput) {
    const setupDraft = draftFromIntent(intent, profileName);
    return {
      profileName,
      ...(setupDraft.provider ? { provider: setupDraft.provider } : {}),
      setupDraft,
    };
  }

  if (activeError) {
    return {
      profileName,
      ...(intent.globals.provider ? { provider: intent.globals.provider } : {}),
      profileError: activeError,
      setupDraft: draftFromIntent(intent, profileName),
    };
  }

  const readProfile = runtime.profiles?.readProfile(profileName);
  if (!readProfile) {
    return {
      profileName,
      ...(intent.globals.provider ? { provider: intent.globals.provider } : {}),
      setupDraft: draftFromIntent(intent, profileName),
    };
  }

  if ("code" in readProfile) {
    return {
      profileName,
      ...(intent.globals.provider ? { provider: intent.globals.provider } : {}),
      profileError: readProfile,
      setupDraft: draftFromIntent(intent, profileName),
    };
  }

  if (explicitLaunchInput) {
    const setupDraft = overlayIntentInput(draftFromProfile(readProfile), intent);
    return {
      profileName,
      ...(setupDraft.provider ? { provider: setupDraft.provider } : {}),
      setupDraft,
    };
  }

  return {
    profileName,
    provider: readProfile.provider,
    profile: readProfile,
    setupDraft: draftFromProfile(readProfile),
  };
};
