export type StartArgs = {
  callId: string;
  lead: {
    id: string; owner_name: string; phone: string; condo: string; unit: string | null; rent: number | null;
    customer_nationalities: string | null; viewing_when: string | null;
  };
  settings: {
    company: string; default_nationalities: string; viewing_when: string;
    vapi_assistant_id: string | null; vapi_phone_number_id: string | null;
  };
};

export type StartResult = { providerCallId?: string | null; simEndAt?: string | null };

export interface CallProvider {
  name: "simulate" | "vapi";
  start(args: StartArgs): Promise<StartResult>;
}
