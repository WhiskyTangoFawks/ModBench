using MEditService.TestSupport;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Xunit.Abstractions;

[assembly: Xunit.TestFramework("MEditService.Commands.Tests.WarmTestFramework", "MEditService.Commands.Tests")]

namespace MEditService.Commands.Tests;

/// <summary>Mutagen's first write costs seconds once per process, so it runs before any test does
/// rather than inside whichever tests happen to start first.</summary>
public sealed class WarmTestFramework(IMessageSink messageSink) : SchemaWarmedTestFramework(messageSink)
{
    protected override void Warm()
    {
        base.Warm();
        using var stream = new MemoryStream();
        new Fallout4Mod(ModKey.FromFileName("WarmUp.esp"), Fallout4Release.Fallout4).WriteToBinary(stream);
    }
}
