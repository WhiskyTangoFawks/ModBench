using MEditService.Index;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.Tests;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Plugins;

// The registration lookup and the held-copies lookup share one name comparison, the kernel's
// PluginCopyKey.Comparer: a key that differs only in case names the same copy at both doors.
public sealed class CopyKeyComparisonTests : IDisposable
{
    private readonly ScatteredFixtureData _fixture = new PluginFixtureBuilder("copy-key-comparison")
        .WithPlugin("Cased.esp", mod => mod.Npcs.AddNew("FromCased"), origin: "CasedMod")
        .BuildScattered();

    private readonly LoadOrderHolder _holder = new();
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly IndexProjector _index;

    public CopyKeyComparisonTests()
    {
        _index = Indexes.Open(_holder, notifications: _notifications);
        _index.Reconcile(_holder, _fixture.GameDirectory, _fixture.Plugins, GameRelease.Fallout4);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private static readonly PluginCopyKey OtherCase = new("CASED.ESP", "casedmod");

    // The rival this pins: the record struct's own equality, which is case-sensitive.
    [Fact]
    public void Registers_AnswersTheSameCopy_WhateverTheCase()
    {
        Assert.True(_index.Registers(OtherCase));
    }

    // The rival this pins: a held-copies lookup comparing name and origin its own way, which would
    // miss the copy the gone report names, unindex nothing and still announce a change.
    [Fact]
    public async Task AGoneReportUnderAnotherCase_FindsTheHeldCopyStillOnDisk_AndAnnouncesNothing()
    {
        var entry = _fixture.Plugins.Single();
        var published = _notifications.Notifications.Count;

        await _index.RefreshBinary(OtherCase, Path.Combine(_fixture.GameDirectory, "a-superseded-path", entry.Name));

        Assert.NotEmpty(_index.RequireReads().GetDocuments(entry.KeyOf()));
        Assert.Empty(_notifications.Notifications.Skip(published).OfType<PluginChangedNotification>());
    }
}
