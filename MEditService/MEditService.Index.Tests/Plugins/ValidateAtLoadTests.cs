using MEditService.Index;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Plugins;

/// <summary>ADR-0015 invariant 4: the Indexer validates at load, before the load order answers. A
/// tracked copy whose documents moved while nothing ran is corrected there, not on the next
/// read.</summary>
public sealed class ValidateAtLoadTests : IDisposable
{
    private const string PluginName = "Fixture.esp";
    private const string NpcEditorId = "FixtureNpc";

    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _entry;
    private readonly string _formKey;

    public ValidateAtLoadTests()
    {
        FormKey npc = default;
        _fixture = new PluginFixtureBuilder("validate-at-load")
            .WithPlugin(PluginName, mod => npc = mod.Npcs.AddNew(NpcEditorId).FormKey, origin: "FixtureMod")
            .BuildScattered()
            .Tracked();
        _entry = _fixture.Plugins.Single();
        _formKey = npc.ToString();
    }

    public void Dispose() => _fixture.Dispose();

    [Fact]
    public void AHandEditMadeWhileStopped_IsInTheLoadOrdersAnswer_WithoutReIndexingTheWholePlugin()
    {
        using (var first = Indexes.Reconciled(_fixture, _fixture.InstanceRoot))
        {
            _entry.HandEdit(
                first.RequireReads().DocumentOf(_formKey, _entry.KeyOf()), NpcEditorId, "EditedWhileStopped");
        }

        var entries = new List<LogEntry>();
        using var loggerFactory = LoggerFactory.Create(b =>
        {
            b.SetMinimumLevel(LogLevel.Debug);
            b.AddProvider(new CollectingLoggerProvider(entries));
        });
        var holder = new LoadOrderHolder();
        using var restarted = Indexes.Open(holder, loggerFactory: loggerFactory);

        restarted.Reconcile(holder, _fixture.GameDirectory, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);

        Assert.Equal("EditedWhileStopped", restarted.RequireReads().DocumentOf(_formKey, _entry.KeyOf()).EditorId);
        Assert.DoesNotContain(
            entries, e => e.Message.StartsWith($"Indexing {PluginName} ", StringComparison.Ordinal));
    }
}
