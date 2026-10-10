using MEditService.Codec.Game;
using MEditService.Codec.Serialization;

namespace MEditService.Codec.Fallout4;

public static class Fallout4Codec
{
    public static IGameCodec Instance { get; } = new GameCodec();
}
