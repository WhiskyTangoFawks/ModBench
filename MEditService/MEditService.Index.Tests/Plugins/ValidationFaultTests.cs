using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Time.Testing;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Plugins;

public sealed class ValidationFaultTests : IDisposable
{
    private const string PluginName = "Untracked.esp";

    private readonly ScatteredFixtureData _fixture = new PluginFixtureBuilder("validation-fault")
        .WithPlugin(PluginName, mod => mod.Npcs.AddNew("UntrackedNpc"), origin: "UntrackedMod")
        .BuildScattered();
    private readonly LoadOrderHolder _holder = new();
    private readonly List<LogEntry> _log = [];
    private readonly ILoggerFactory _loggerFactory;

    public ValidationFaultTests() =>
        _loggerFactory = LoggerFactory.Create(b => b.AddProvider(new CollectingLoggerProvider(_log)));

    public void Dispose()
    {
        _loggerFactory.Dispose();
        _fixture.Dispose();
    }

    private LoadOrderEntry Plugin => _fixture.Plugins.Single();

    private Indexer Subscribed(INotificationPublisher? notifications = null, IndexWriteGate? writeGate = null)
    {
        var clock = new FakeTimeProvider(TimeProvider.System.GetUtcNow() + TimeSpan.FromHours(1));
        var index = Indexes.Open(_holder, loggerFactory: _loggerFactory, notifications: notifications, timeProvider: clock, writeGate: writeGate);
        index.Reconcile(_holder, _fixture.GameDirectory, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
        return index;
    }

    private void RewriteThePlugin() =>
        PluginBinaries.Rewrite(Plugin.Path, mod => mod.Npcs.AddNew("WrittenByAnotherTool"));

    private bool Logged(LogLevel level, Func<LogEntry, bool> matches)
    {
        lock (_log) return _log.Exists(e => e.Level == level && matches(e));
    }

    [Fact]
    public async Task AValidationThatWaitsOutTheWriteGate_IsLogged_AndReCheckedAtTheNextSnapshot()
    {
        using var index = Subscribed(writeGate: new IndexWriteGate(TimeSpan.FromMilliseconds(100)));
        RewriteThePlugin();
        using (new GateHeld(index.WriteGate))
        {
            _holder.Apply(_holder.Current);

            Assert.True(
                await Waits.Until(() => Logged(LogLevel.Warning, e => e.Message.Contains("re-checked", StringComparison.Ordinal))),
                "the timed-out validation was never logged");
        }

        _holder.Apply(_holder.Current);

        Assert.True(
            await Waits.Until(() => index.RequireReads().GetDocuments(Plugin.KeyOf()).Any(d => d.EditorId == "WrittenByAnotherTool")),
            "the next snapshot never validated the plugin again");
    }

    [Fact]
    public async Task AValidationThatFaultsOutright_IsLogged_AndNamedInTheStatus()
    {
        using var index = Subscribed(notifications: new PluginChangedFaults());
        RewriteThePlugin();

        _holder.Apply(_holder.Current);

        Assert.True(
            await Waits.Until(() => Logged(LogLevel.Error, e => e.Exception?.Message == PluginChangedFaults.Reason)),
            "the fault was never logged");
        Assert.Equal(LoadOrderState.Failed, index.Status.State);
        Assert.Contains(PluginChangedFaults.Reason, index.Status.Message, StringComparison.Ordinal);
    }

    private sealed class PluginChangedFaults : INotificationPublisher
    {
        public const string Reason = "the stream could not take the push";

        public void Publish(Notification notification)
        {
            if (notification is PluginChangedNotification) throw new InvalidOperationException(Reason);
        }
    }

    private sealed class GateHeld : IDisposable
    {
        private readonly ManualResetEventSlim _release = new();
        private readonly Task _holder;

        public GateHeld(IndexWriteGate gate)
        {
            using var held = new ManualResetEventSlim();
            _holder = Task.Run(() =>
            {
                using var _ = gate.Enter();
                held.Set();
                _release.Wait(TimeSpan.FromSeconds(30));
            });
            if (!held.Wait(TimeSpan.FromSeconds(10))) throw new InvalidOperationException("The gate was never taken.");
        }

        public void Dispose()
        {
            _release.Set();
            _holder.GetAwaiter().GetResult();
            _release.Dispose();
        }
    }
}
