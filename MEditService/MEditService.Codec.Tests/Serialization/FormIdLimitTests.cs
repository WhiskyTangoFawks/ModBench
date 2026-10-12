using MEditService.Codec.Serialization;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Codec.Tests.Serialization;

public sealed class FormIdLimitTests
{
    private static readonly ModKey Plugin = ModKey.FromFileName("Light.esl");
    private static readonly ModKey Master = ModKey.FromFileName("Master.esm");
    private static readonly FormIdLimit Light = new("light", 0x800, 0xFFF, ByFlag: true, ByExtension: false);

    [Fact]
    public void OnlyTheNativeFormKeysOutsideTheRange_AreOutside()
    {
        FormKey[] keys =
        [
            new(Plugin, 0x800),
            new(Plugin, 0xFFF),
            new(Plugin, 0x7FF),
            new(Plugin, 0x1000),
            new(Master, 0x1),
        ];

        Assert.Equal([new FormKey(Plugin, 0x7FF), new FormKey(Plugin, 0x1000)], Light.Outside(Plugin, keys));
    }
}
