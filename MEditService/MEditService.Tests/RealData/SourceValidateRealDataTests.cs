using System.Diagnostics;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using Xunit.Abstractions;

namespace MEditService.Tests.RealData;

/// <summary>Validate on 3,900-odd authentic records, freshly ingested from their own source tree, so
/// validate must find nothing. A synthetic fixture cannot make this claim: it holds no containers,
/// no worldspace and no embedded children.</summary>
public sealed class SourceValidateRealDataTests(SourceParityFixture fixture, ITestOutputHelper output)
    : IClassFixture<SourceParityFixture>
{
    private IRecordIndex Index => fixture.FromSource.Store!;

    [Fact]
    public void AFreshlyIngestedRealPlugin_ValidatesCleanAndAdvancesNoSequence()
    {
        var before = Index.Sequence;

        var timer = Stopwatch.StartNew();
        var report = Index.Validate(fixture.Plugin, fixture.ModFolder);
        output.WriteLine($"validate took {timer.ElapsedMilliseconds} ms; {report.ChangedKeys.Count} rows changed");

        Assert.Empty(report.Failures);
        Assert.False(report.NeedsRebuild);
        Assert.Empty(report.ChangedKeys);
        Assert.Equal(before, Index.Sequence);
    }

    // The all-plugins call, over an instance holding a real plugin: it has to finish and say how many
    // rows it changed, which is the number the Loadout header's refresh will show.
    [Fact]
    public void ReconcilingEveryPlugin_CompletesAndReportsHowManyRowsChanged()
    {
        var timer = Stopwatch.StartNew();
        var reports = fixture.FromSource.ValidateIndex(plugin: null);
        output.WriteLine(
            $"reconcile of {reports.Count} plugin(s) took {timer.ElapsedMilliseconds} ms; " +
            $"{reports.Sum(r => r.ChangedKeys.Count)} rows changed");

        Assert.NotEmpty(reports);
        Assert.All(reports, r => Assert.Empty(r.Failures));
        Assert.Equal(0, reports.Sum(r => r.ChangedKeys.Count));
        Assert.DoesNotContain(reports, r => r.NeedsRebuild);
    }
}
