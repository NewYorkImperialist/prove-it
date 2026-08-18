"use strict";
// Discord-style :shortcode: → emoji for in-game chat. No picker: you just type it like
// Discord and the completed shortcode is swapped as you go (see the input bar) and again
// on send, so what everyone reads is the emoji.
const EMOJI = {
  skull: "💀", fire: "🔥", joy: "😂", sob: "😭", cry: "😢", heart: "❤️", hearts: "💕",
  sparkling_heart: "💖", broken_heart: "💔", thumbsup: "👍", "+1": "👍", thumbsdown: "👎",
  "-1": "👎", 100: "💯", eyes: "👀", clown: "🤡", clown_face: "🤡", pray: "🙏", tada: "🎉",
  party: "🥳", partying_face: "🥳", rofl: "🤣", smile: "😄", smiley: "😃", grin: "😁",
  laughing: "😆", sweat_smile: "😅", wink: "😉", blush: "😊", sunglasses: "😎", cool: "😎",
  thinking: "🤔", thinking_face: "🤔", rage: "😡", angry: "😠", poop: "💩", ok_hand: "👌",
  wave: "👋", clap: "👏", muscle: "💪", brain: "🧠", rocket: "🚀", star: "⭐", sparkles: "✨",
  crown: "👑", moneybag: "💰", money_mouth: "🤑", nerd: "🤓", nerd_face: "🤓", flushed: "😳",
  pleading_face: "🥺", pleading: "🥺", smirk: "😏", sleeping: "😴", nauseated_face: "🤢",
  sick: "🤢", vomiting: "🤮", exploding_head: "🤯", mind_blown: "🤯", cold_face: "🥶",
  hot_face: "🥵", melting_face: "🫠", saluting_face: "🫡", salute: "🫡", ghost: "👻",
  alien: "👽", robot: "🤖", gem: "💎", zap: "⚡", boom: "💥", v: "✌️", peace: "✌️",
  pinched_fingers: "🤌", handshake: "🤝", raised_hands: "🙌", facepalm: "🤦", shrug: "🤷",
  dizzy: "💫", sweat_drops: "💦", zzz: "💤", checkered_flag: "🏁", trophy: "🏆", medal: "🏅",
  first_place: "🥇", second_place: "🥈", third_place: "🥉", game_die: "🎲", dart: "🎯",
  soccer: "⚽", basketball: "🏀", football: "🏈", baseball: "⚾", goat: "🐐", cat: "🐱",
  dog: "🐶", snake: "🐍", pig: "🐷", frog: "🐸", monkey: "🐵", fox: "🦊", bear: "🐻",
  lion: "🦁", unicorn: "🦄", kiss: "😘", heart_eyes: "😍", drooling_face: "🤤",
  upside_down: "🙃", neutral_face: "😐", grimacing: "😬", zany_face: "🤪", star_struck: "🤩",
  hugging: "🤗", raised_eyebrow: "🤨", monocle: "🧐", yawning_face: "🥱", woozy_face: "🥴",
  cowboy: "🤠", fingers_crossed: "🤞", fist: "👊", punch: "👊", call_me: "🤙",
  white_check_mark: "✅", check: "✅", x: "❌", question: "❓", exclamation: "❗",
  point_right: "👉", point_left: "👈", point_up: "👆", point_down: "👇", ok: "🆗",
  warning: "⚠️",
};

// Replace every complete :shortcode: we know; unknown ones are left as typed.
const emojify = (s) => String(s).replace(/:([a-z0-9_+-]+):/gi, (m, c) => EMOJI[c.toLowerCase()] || m);

module.exports = { EMOJI, emojify };
