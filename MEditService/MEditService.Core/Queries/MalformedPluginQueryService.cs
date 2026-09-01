using System.Diagnostics;
using MEditService.Core.Plugins;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;

namespace MEditService.Core.Queries;

/// <summary>
/// The session-load half of the Kind B detectors (#570): scans every held, mutable plugin's
/// binary with <see cref="MalformedPluginScan"/> — original bytes only, no Mutagen — so a
/// silently-lossy plugin is named the moment the load order arrives instead of looking healthy
/// until Track. Immutable plugins are never diagnosed: they are the proof set the tables were
/// built from (<c>docs/specs/medit-repair.md</c>); a hit there is the vanilla-proof test's bug to
/// catch, never a user-facing diagnosis.
/// </summary>
public sealed class MalformedPluginQueryService(ILoadOrderMirror mirror, ILogger<MalformedPluginQueryService>? logger = null)
{
    public IReadOnlyList<PluginDiagnosisReport> GetLoadOrderDiagnoses()
    {
        var (loadOrder, _) = mirror.RequireScope();
        return ScanAll(loadOrder.Plugins, logger);
    }

    internal static List<PluginDiagnosisReport> ScanAll(IReadOnlyList<PluginMetadata> plugins, ILogger? logger)
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
        // #570 AC: the load-time cost is measured and reported, not assumed.
        if (logger is not null && logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "Kind B malformed-plugin scan: {Plugins} plugins, {Diagnoses} diagnoses, {Ms} ms",
                scanned, reports.Count, stopwatch.ElapsedMilliseconds);
        }
        return reports;
    }
}
