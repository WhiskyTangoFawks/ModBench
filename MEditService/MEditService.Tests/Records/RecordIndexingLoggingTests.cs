using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Records;

// #217: the per-plugin VMAD/conditions summary lines duplicate the per-plugin progress milestone
// SessionManager already logs at Info (#216), so they move to Debug here. Individual record
// processing during indexing (append, VMAD, conditions) gets new Trace coverage — the "per-record
// trace" gap the original #205/#215 audit called out. Indexing *behavior* (rows land correctly,
// VMAD/conditions round-trip) is already covered by DuckDbRecordIndexTests, VmadIndexerTests
// and ConditionIndexerTests, which remain the safety net for this reclassification; this file only
// asserts on log level/content, which none of those do.
public sealed class RecordIndexingLoggingTests : IDisposable
{
    private static readonly ISchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly ITableDdlBuilder Ddl = new TableDdlBuilder(Reflector);

    private readonly FormKey _npcFormKey;
    private readonly FormKey _cobjFormKey;
    private readonly PluginFixtureData _fixture;

    public RecordIndexingLoggingTests()
    {
        FormKey npcFk = default, cobjFk = default;
        _fixture = new PluginFixtureBuilder("s217")
            .WithPlugin("LogTrace.esp", mod =>
            {
                var quest = mod.Quests.AddNew("SomeQuest");

                var npc = mod.Npcs.AddNew("ScriptedNpc");
                npcFk = npc.FormKey;
                var vmad = new VirtualMachineAdapter();
                var script = new ScriptEntry { Name = "DefaultScript", Flags = ScriptEntry.Flag.Local };
                script.Properties.Add(new ScriptBoolProperty { Name = "IsActive", Data = true });
                vmad.Scripts.Add(script);
                npc.VirtualMachineAdapter = vmad;

                var cobj = mod.ConstructibleObjects.AddNew("TestRecipe");
                cobjFk = cobj.FormKey;
                var data = new FunctionConditionData
                {
                    Function = Condition.Function.GetStageDone,
                    ParameterTwoNumber = 10,
                };
                data.ParameterOneRecord.SetTo(quest.FormKey);
                cobj.Conditions.Add(new ConditionFloat
                {
                    CompareOperator = CompareOperator.EqualTo,
                    ComparisonValue = 1.0f,
                    Data = data,
                });
            })
            .Build();
        _npcFormKey = npcFk;
        _cobjFormKey = cobjFk;
    }

    public void Dispose() => _fixture.Dispose();

    private static (ILoggerFactory factory, List<LogEntry> entries) CapturingLoggerFactory()
    {
        var entries = new List<LogEntry>();
        var factory = LoggerFactory.Create(b =>
        {
            b.SetMinimumLevel(LogLevel.Trace);
            b.AddProvider(new CollectingLoggerProvider(entries));
        });
        return (factory, entries);
    }

    private DuckDbRecordIndex IndexedRepository(ILogger logger)
    {
        var repo = new DuckDbRecordIndex(Reflector, Ddl, logger);
        repo.Initialize(GameRelease.Fallout4);
        var modPath = new ModPath(
            ModKey.FromFileName("LogTrace.esp"),
            Path.Combine(_fixture.DataFolder, "LogTrace.esp"));
        var mod = (IModGetter)Fallout4Mod.CreateFromBinaryOverlay(modPath, Fallout4Release.Fallout4);
        repo.Index(mod, 0, participates: true, origin: "Data");
        return repo;
    }

    [Fact]
    public void Index_PerPluginVmadAndConditionSummaries_LogAtDebugNotInformation()
    {
        var (loggerFactory, entries) = CapturingLoggerFactory();
        using var _ = loggerFactory;
        using var repo = IndexedRepository(loggerFactory.CreateLogger(nameof(DuckDbRecordIndex)));

        Assert.Contains(entries, e => e.Level == LogLevel.Debug && e.Message.Contains("Indexed VMAD for"));
        Assert.DoesNotContain(entries, e => e.Level == LogLevel.Information && e.Message.Contains("Indexed VMAD for"));

        Assert.Contains(entries, e => e.Level == LogLevel.Debug && e.Message.Contains("Indexed conditions for"));
        Assert.DoesNotContain(entries, e => e.Level == LogLevel.Information && e.Message.Contains("Indexed conditions for"));
    }

    [Fact]
    public void Index_PerRecordAppend_LogsAtTraceWithFormKey()
    {
        var (loggerFactory, entries) = CapturingLoggerFactory();
        using var _ = loggerFactory;
        using var repo = IndexedRepository(loggerFactory.CreateLogger(nameof(DuckDbRecordIndex)));

        Assert.Contains(entries, e =>
            e.Level == LogLevel.Trace && e.Message.Contains(_npcFormKey.ToString()) && e.Message.Contains("Appended"));
    }

    [Fact]
    public void Index_PerRecordVmad_LogsAtTraceWithFormKey()
    {
        var (loggerFactory, entries) = CapturingLoggerFactory();
        using var _ = loggerFactory;
        using var repo = IndexedRepository(loggerFactory.CreateLogger(nameof(DuckDbRecordIndex)));

        Assert.Contains(entries, e =>
            e.Level == LogLevel.Trace
            && e.Message.Contains(_npcFormKey.ToString())
            && e.Message.Contains("Indexed VMAD for"));
    }

    [Fact]
    public void Index_PerRecordConditions_LogsAtTraceWithFormKey()
    {
        var (loggerFactory, entries) = CapturingLoggerFactory();
        using var _ = loggerFactory;
        using var repo = IndexedRepository(loggerFactory.CreateLogger(nameof(DuckDbRecordIndex)));

        Assert.Contains(entries, e =>
            e.Level == LogLevel.Trace
            && e.Message.Contains(_cobjFormKey.ToString())
            && e.Message.Contains("Indexed conditions for"));
    }
}
