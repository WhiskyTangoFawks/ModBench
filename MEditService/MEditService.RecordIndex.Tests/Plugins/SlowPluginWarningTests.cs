using MEditService.LoadOrder;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Time.Testing;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class SlowPluginWarningTests : IDisposable
{
    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _plugin;
    private readonly string _npc;
    private readonly FakeTimeProvider _clock = new(TimeProvider.System.GetUtcNow());
    private readonly LoadOrderHolder _holder = new();
    private readonly List<LogEntry> _log = [];
    private readonly ILoggerFactory _loggers;
    private readonly CountingTreeSource _source;
    private readonly OpenedIndex _index;

    public SlowPluginWarningTests()
    {
        string npc = "";
        _fixture = new PluginFixtureBuilder("slow-plugin-warning")
            .WithPlugin("Slow.esp", mod => npc = mod.Npcs.AddNew("SlowNpc").FormKey.ToString(), origin: "SlowMod")
            .BuildScattered();
        _plugin = _fixture.Plugins.Single();
        _npc = npc;
        SourceMods.Init(_plugin);
        _source = new CountingTreeSource(TestAdapters.Source(_clock));
        _loggers = LoggerFactory.Create(b => b.AddProvider(new CollectingLoggerProvider(_log)));
        _index = Indexes.Open(_holder, loggerFactory: _loggers, timeProvider: _clock, source: _source);
    }

    public void Dispose()
    {
        _index.Dispose();
        _loggers.Dispose();
        _fixture.Dispose();
    }

    private void ItsGitStatusTakes(int seconds) => _source.BeforeNextGitStatus = () => _clock.Advance(TimeSpan.FromSeconds(seconds));

    private void Launch() => _index.Reconcile(_holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);

    private List<string> Warnings()
    {
        lock (_log) return [.. _log.Where(entry => entry.Level == LogLevel.Warning).Select(entry => entry.Message)];
    }

    [Theory]
    [InlineData(9, new string[0])]
    [InlineData(11, new[] { "Reading Slow.esp (SlowMod) took 11 s" })]
    public void AReadOfOnePlugin_IsWarnedOfPastTenSeconds(int seconds, string[] warned)
    {
        ItsGitStatusTakes(seconds);

        Launch();

        Assert.Equal(warned, Warnings());
    }

    [Fact]
    public void ACheckOfOnePlugin_IsWarnedOfPastTenSeconds()
    {
        Launch();
        _plugin.HandEdit(_index.DocumentOf(_npc, _plugin.Key), "\"SlowNpc\"", "\"Edited\"");
        ItsGitStatusTakes(11);

        _index.NextCheckUntil(() => _index.CopyIn(_npc, _plugin.Key)?.EditorId == "Edited", "the edit read");

        Assert.Equal(["Checking Slow.esp (SlowMod) took 11 s"], Warnings());
    }
}
