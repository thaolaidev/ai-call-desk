export type StartArgs = {
  callId: string;
  lead: {
    id: string; owner_name: string; phone: string; condo: string; unit: string | null; rent: number | null;
    customer_nationalities: string | null; viewing_when: string | null; external_id?: string | null;
  };
  settings: {
    company: string; default_nationalities: string; viewing_when: string;
    vapi_assistant_id: string | null; vapi_phone_number_id: string | null;
    yalecom_caller_id?: string | null; yalecom_transfer_to?: string | null;
  };
};

export type StartResult = { providerCallId?: string | null; simEndAt?: string | null };

export interface CallProvider {
  name: "simulate" | "vapi" | "yalecom";
  start(args: StartArgs): Promise<StartResult>;
}
