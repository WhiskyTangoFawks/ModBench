using MEditService.Index.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Records;

// A per-plugin summary line duplicates the progress milestone the reconcile logs at Info, so it
// logs at Debug and per-record processing logs at Trace. Only log level and content are asserted
// here; RecordReadsTests covers whether the rows land.
public sealed class RecordIndexingLoggingTests : IDisposable
{
    private readonly FormKey _npcFormKey;
    private readonly PluginFixtureData _fixture;

    public RecordIndexingLoggingTests()
    {
        FormKey npcFk = default;
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
    }

    public void Dispose() => _fixture.Dispose();

    [Fact]
    public void Index_PerRecordAppend_LogsAtTraceWithFormKey()
    {
        var entries = new List<LogEntry>();
        using var loggerFactory = LoggerFactory.Create(b =>
        {
            b.SetMinimumLevel(LogLevel.Trace);
            b.AddProvider(new CollectingLoggerProvider(entries));
        });
        using var index = Indexes.Reconciled(_fixture, loggerFactory: loggerFactory);

        Assert.Contains(entries, e =>
            e.Level == LogLevel.Trace && e.Message.Contains(_npcFormKey.ToString()) && e.Message.Contains("Appended"));
    }
}
