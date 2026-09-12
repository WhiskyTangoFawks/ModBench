using System.Diagnostics;
using MEditService.Codec.Serialization;
using MEditService.Index;
using MEditService.LoadOrder;
using Microsoft.Extensions.Logging;

namespace MEditService.Queries;

/// <summary>Kind B detection: original bytes only, no Mutagen. Immutable plugins are never
/// diagnosed — they are the proof set the tables were built from (docs/specs/medit-repair.md),
/// so a hit there is a test bug.</summary>
public sealed class MalformedPluginQueryService(LoadOrderHolder loadOrder, ILogger<MalformedPluginQueryService>? logger = null)
{
    public IReadOnlyList<PluginDiagnosisReport> GetLoadOrderDiagnoses() =>
        ScanAll(loadOrder.Require().Copies, logger);

    internal static List<PluginDiagnosisReport> ScanAll(IReadOnlyList<RegisteredCopy> plugins, ILogger? logger)
    {
        var stopwatch = Stopwatch.StartNew();
        var reports = new List<PluginDiagnosisReport>();
        var scanned = 0;
        foreach (var plugin in plugins)
        {
            // A file gone from disk between reconcile and this scan is validation's finding, not
            // this scan's (never assume exclusive ownership of a file on disk).
            if (plugin.IsImmutable || !File.Exists(plugin.Path)) continue;
            scanned++;
            foreach (var d in MalformedPluginScan.Scan(File.ReadAllBytes(plugin.Path)))
                reports.Add(new PluginDiagnosisReport(plugin.Name, plugin.Origin, d.Anchor, d.DefectClass, d.Tail, d.Message, d.Describe()));
        }
        stopwatch.Stop();
        // The load-time cost is measured and reported, not assumed.
        if (logger is not null && logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Kind B malformed-plugin scan: {Plugins} plugins, {Diagnoses} diagnoses, {Ms} ms",
                scanned, reports.Count, stopwatch.ElapsedMilliseconds);
        }
        return reports;
    }
}
