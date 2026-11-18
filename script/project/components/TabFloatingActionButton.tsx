import { Button, Image, Text, VStack, type PopoverPresentation } from "scripting";

const DIAMETER = 56;
const INSET = 20;
const BACKGROUND = { light: "#9EF0FC", dark: "#004F57" } as const;
const FOREGROUND = { light: "#004F57", dark: "#9EF0FC" } as const;
export const TAB_FAB_SCROLL_INSET = DIAMETER + INSET;

export function TabFloatingActionButton({ title, symbol, action, popover }: {
  title: string;
  symbol: string;
  action: () => void;
  popover?: PopoverPresentation;
}) {
  return (
    <VStack padding={{ trailing: INSET, bottom: INSET }}>
      <Button buttonStyle="plain" action={action} popover={popover}>
        <VStack spacing={1}
          frame={{ width: DIAMETER, height: DIAMETER }}
          background={{ style: BACKGROUND, shape: "circle" }}
          shadow={{ color: "rgba(0,0,0,0.15)", radius: 12, x: 0, y: 4 }}
          contentShape="circle">
          <Image systemName={symbol} font={24} fontWeight="semibold" foregroundStyle={FOREGROUND} />
          <Text font={9} fontWeight="medium" foregroundStyle={FOREGROUND}>{title}</Text>
        </VStack>
      </Button>
    </VStack>
  );
}
