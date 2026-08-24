export function transientToast(
  message: string,
  setMessage: (message: string) => void,
) {
  return {
    isPresented: Boolean(message),
    onChanged: (isPresented: boolean) => {
      if (!isPresented) setMessage("");
    },
    message,
    duration: 2,
    position: "bottom" as const,
  };
}
