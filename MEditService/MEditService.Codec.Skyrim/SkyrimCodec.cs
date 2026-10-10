using MEditService.Codec.Game;
using MEditService.Codec.Serialization;

namespace MEditService.Codec.Skyrim;

public static class SkyrimCodec
{
    public static IGameCodec Instance { get; } = new GameCodec();
}
