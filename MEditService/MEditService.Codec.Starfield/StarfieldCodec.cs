using MEditService.Codec.Game;
using MEditService.Codec.Serialization;

namespace MEditService.Codec.Starfield;

public static class StarfieldCodec
{
    public static IGameCodec Instance { get; } = new GameCodec();
}
