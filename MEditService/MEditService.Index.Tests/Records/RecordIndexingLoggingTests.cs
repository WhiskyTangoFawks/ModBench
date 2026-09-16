using MEditService.Codec.Schema;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Records;

// A per-plugin summary line duplicates the progress milestone IndexProjector logs at Info, so it
// logs at Debug and per-record processing logs at Trace. Only log level and content are asserted
// here; DuckDbRecordIndexTests covers whether the rows land.
public sealed class RecordIndexingLoggingTests : IDisposable
{
    private static readonly SchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly TableDdlBuilder Ddl = new TableDdlBuilder(Reflector);

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
        DuckDbRecordIndex? repo = new DuckDbRecordIndex(Reflector, Ddl, logger);
        try
        {
            repo.Initialize(GameRelease.Fallout4);
            var modPath = new ModPath(
                ModKey.FromFileName("LogTrace.esp"),
                Path.Combine(_fixture.DataFolder, "LogTrace.esp"));
            using var mod = Fallout4Mod.CreateFromBinaryOverlay(modPath, Fallout4Release.Fallout4);
            repo.IndexMod(mod, Registration.Participating(0), new PluginCopyKey(mod.ModKey.FileName.ToString(), "Data"));
            var indexed = repo;
            repo = null;
            return indexed;
        }
        finally
        {
            repo?.Dispose();
        }
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

}
