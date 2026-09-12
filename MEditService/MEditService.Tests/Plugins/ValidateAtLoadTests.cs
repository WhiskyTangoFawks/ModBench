using MEditService.Codec.Schema;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Tests.Plugins;

/// <summary>ADR-0015 invariant 4: the projector validates at load, before the load order answers. A
/// tracked copy whose documents moved while nothing ran is corrected there, not on the next
/// read.</summary>
public sealed class ValidateAtLoadTests
{
    [Fact]
    public void AHandEditMadeWhileStopped_IsInTheLoadOrdersAnswer_WithoutReIndexingTheWholePlugin()
    {
        var holder = new LoadOrderHolder();
        using var mod = IndexedModFixture.TrackedPersistent();
        var formKey = mod.Npc.ToString();
        var text = File.ReadAllText(mod.NpcSourceFile);
        File.WriteAllText(mod.NpcSourceFile, text.Replace("\"FixtureNpc\"", "\"EditedWhileStopped\"", StringComparison.Ordinal));
        mod.Index.Dispose();

        var entries = new List<LogEntry>();
        using var loggerFactory = LoggerFactory.Create(b =>
        {
            b.SetMinimumLevel(LogLevel.Debug);
            b.AddProvider(new CollectingLoggerProvider(entries));
        });
        var reflector = SharedSchemaReflector.Instance;
        using var restarted = new IndexProjector(
            holder,
            MutagenPluginAdapter.Instance,
            new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector)),
            loggerFactory.CreateLogger<IndexProjector>());

        restarted.Reconcile(holder,
            mod.GameDirectory, [mod.Entry], GameRelease.Fallout4, mod.InstanceRoot);

        Assert.Equal(
            "EditedWhileStopped",
            restarted.Store!.At(RecordRef.Effective).GetDocument(formKey, mod.Plugin)!.EditorId);
        Assert.DoesNotContain(
            entries, e => e.Message.StartsWith($"Indexing {IndexedModFixture.PluginName} ", StringComparison.Ordinal));
    }
}
