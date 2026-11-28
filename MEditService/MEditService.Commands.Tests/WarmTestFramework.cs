using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Xunit.Abstractions;

[assembly: Xunit.TestFramework("MEditService.Commands.Tests.WarmTestFramework", "MEditService.Commands.Tests")]

namespace MEditService.Commands.Tests;

/// <summary>The whole-mod door's first write and read cost seconds once per process too.</summary>
public sealed class WarmTestFramework(IMessageSink messageSink) : SchemaWarmedTestFramework(messageSink)
{
    protected override void Warm()
    {
        base.Warm();
        var mod = new Fallout4Mod(ModKey.FromFileName("WarmUp.esp"), Fallout4Release.Fallout4);
        mod.Npcs.AddNew("WarmUpNpc");
        using var wholeMod = new ScratchDirectory("medit-warm-up-");
        Fallout4WholeMod.Serialize(mod, wholeMod).GetAwaiter().GetResult();
        Fallout4WholeMod.Deserialize(wholeMod).GetAwaiter().GetResult()
            .BeginWrite.ToPath(Path.Combine(wholeMod, "WarmUp.esp")).WithLoadOrder(Array.Empty<ModKey>()).WithNoDataFolder().WriteAsync().GetAwaiter().GetResult();
    }
}
