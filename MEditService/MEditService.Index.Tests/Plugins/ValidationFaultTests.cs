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

    private OpenedIndex Subscribed(INotificationPublisher? notifications = null)
    {
        var clock = new FakeTimeProvider(TimeProvider.System.GetUtcNow() + TimeSpan.FromHours(1));
        var index = Indexes.Open(_holder, loggerFactory: _loggerFactory, notifications: notifications, timeProvider: clock);
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
    public void AValidationThatFaultsOutright_IsLogged_AndNamedInTheStatus()
    {
        using var index = Subscribed(notifications: new PluginChangedFaults());
        RewriteThePlugin();

        index.NextSnapshotUntil(() => index.Status.State == LoadOrderState.Failed, "the failed status");

        Assert.True(Logged(LogLevel.Error, e => e.Exception?.Message == PluginChangedFaults.Reason), "the fault was never logged");
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
}
