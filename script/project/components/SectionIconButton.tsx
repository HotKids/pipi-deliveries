import { Button } from "scripting";

export function SectionIconButton({ title, symbol, disabled, action }: {
  title: string;
  symbol: string;
  disabled: boolean;
  action: () => void;
}) {
  return (
    <Button title={title} systemImage={symbol} labelStyle="iconOnly" buttonStyle="plain"
      font={17} fontWeight="medium" foregroundStyle={disabled ? "tertiaryLabel" : "systemBlue"}
      frame={{ width: 28, height: 28, alignment: "trailing" }}
      disabled={disabled} action={action} />
  );
}
