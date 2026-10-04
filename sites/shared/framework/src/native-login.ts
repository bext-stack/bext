export interface NativeLoginUser {
  id: string;
  email?: string | null;
  name?: string | null;
  tenant_id?: string | null;
}

export interface NativeLoginTenant {
  id: string;
  name?: string | null;
}

export type NativeLoginResult =
  | {
      kind: "success";
      user: NativeLoginUser;
      token?: string;
      sessionId?: string;
    }
  | {
      kind: "tenant_selection_required";
      tenants: NativeLoginTenant[];
      message: string;
    };

interface NativeLoginPayload {
  status?: string;
  error?: string;
  user?: NativeLoginUser;
  token?: string;
  session_id?: string;
  tenants?: NativeLoginTenant[];
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class NativeLoginError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "NativeLoginError";
  }
}

/**
 * Tenant-aware password authentication against auth-rust.
 *
 * The first request deliberately omits tenant_id so an email attached to
 * several workspaces produces a picker. The selected tenant is then sent on
 * the follow-up request, making the resulting identity deterministic.
 */
export async function nativePasswordLogin(args: {
  issuer: string;
  email: string;
  password: string;
  tenantId?: string;
  fetcher?: FetchLike;
}): Promise<NativeLoginResult> {
  const fetcher = args.fetcher ?? fetch;
  const body: Record<string, string> = {
    email: args.email,
    password: args.password,
    redirect_to: "/",
  };
  if (args.tenantId) body.tenant_id = args.tenantId;

  let response: Response;
  try {
    response = await fetcher(args.issuer.replace(/\/$/, "") + "/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new NativeLoginError(
      502,
      "upstream_unreachable",
      "Service d'authentification injoignable. Réessayez dans un instant.",
    );
  }

  let payload: NativeLoginPayload = {};
  try {
    payload = (await response.json()) as NativeLoginPayload;
  } catch {
    // Status mapping below intentionally avoids reflecting upstream content.
  }

  if (!response.ok) {
    if (response.status === 429) {
      throw new NativeLoginError(
        429,
        "locked",
        "Trop de tentatives. Réessayez dans quelques minutes.",
      );
    }
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new NativeLoginError(
        response.status === 400 ? 400 : 401,
        response.status === 400 ? "invalid_request" : "invalid_credentials",
        response.status === 400
          ? "Requête de connexion invalide. Recommencez."
          : "Email ou mot de passe incorrect.",
      );
    }
    throw new NativeLoginError(
      502,
      "upstream_error",
      "Réponse inattendue du service d'authentification. Réessayez dans un instant.",
    );
  }

  if (payload.status === "tenant_selection_required") {
    const tenants = (payload.tenants ?? []).filter(
      (tenant): tenant is NativeLoginTenant => Boolean(tenant?.id),
    );
    if (!tenants.length) {
      throw new NativeLoginError(502, "upstream_error", "La liste des espaces est vide.");
    }
    return {
      kind: "tenant_selection_required",
      tenants,
      message: "Plusieurs espaces sont associés à cette adresse. Choisissez celui à ouvrir.",
    };
  }

  if (!payload.user?.id) {
    throw new NativeLoginError(
      502,
      "upstream_error",
      "Réponse d'authentification incomplète.",
    );
  }
  return {
    kind: "success",
    user: payload.user,
    token: payload.token,
    sessionId: payload.session_id,
  };
}
