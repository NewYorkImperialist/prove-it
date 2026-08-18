import SocketProvider from "@/components/SocketProvider";
import AppShell from "@/components/AppShell";

// One page for everything: multiplayer, Challenge Race, solo and the daily all live in the same
// document (as they always have), with the realtime connection provided above them.
export default function Page() {
  return (
    <SocketProvider>
      <AppShell />
    </SocketProvider>
  );
}
