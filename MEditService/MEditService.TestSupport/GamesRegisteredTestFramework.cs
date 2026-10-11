using MEditService.Codec.Fallout4;
using MEditService.Codec.Serialization;
using MEditService.Codec.Skyrim;
using MEditService.Codec.Starfield;
using Mutagen.Bethesda;
using Xunit.Abstractions;
using Xunit.Sdk;

namespace MEditService.TestSupport;

/// <summary>The game projects registered before any test runs, as the composition root registers
/// them before the service starts.</summary>
public class GamesRegisteredTestFramework : XunitTestFramework
{
    public GamesRegisteredTestFramework(IMessageSink messageSink) : base(messageSink) =>
        GameCodecs.Register(new Dictionary<GameCategory, IGameCodec>
        {
            [GameCategory.Fallout4] = Fallout4Codec.Instance,
            [GameCategory.Skyrim] = SkyrimCodec.Instance,
            [GameCategory.Starfield] = StarfieldCodec.Instance,
        });
}
