using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.PluginAdapter.Repair;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands.Edits;

/// <summary>A plugin's bytes as the whole-mod door's tree of its plugin source, or why they cannot be: ADR-0006's
/// gate refused it, or it cannot be read. Writes nothing.</summary>
internal sealed record Decompiled(PluginSource? Source, DecompileRefusal Refusal, string Message)
{
    internal static Decompiled Refused(DecompileRefusal refusal, string message) => new(null, refusal, message);

    internal static Decompiled Refused(RoundTripRefusal refusal) =>
        Refused(refusal.RepairClears ? DecompileRefusal.MalformedRepairable : DecompileRefusal.RoundTripFailed, refusal.Message);
}

/// <summary>A round-trip refusal's fact, and whether decompile and repair clears it.</summary>
internal readonly record struct RoundTripRefusal(string Message, bool RepairClears = false);

/// <summary>Init and decompile both read a plugin into its plugin source through this one gate.
/// </summary>
internal sealed class PluginDecompiler(ILogger logger, IPluginAdapter adapter, ISourceAdapter sourceAdapter, SchemaReflector schemaReflector)
{
    internal async Task<Decompiled> DecompileAsync(
        LoadOrderSnapshot loadOrder, RegisteredPlugin plugin, string modFolder, Action onParsed, CancellationToken cancel)
    {
        // A fresh deep parse, not the load order's own overlay, whose lifetime this gate does not control.
        if (!(await adapter.ReadSourceOfAsync(plugin, loadOrder, cancel)).Holds(out var source, out var failure))
        {
            logger.LogWarning(failure.Error, "Refused to decompile {Plugin}: {Reason}", plugin.Name, failure.Reason);
            return failure switch
            {
                PluginFailure.MissingStrings missing => Decompiled.Refused(DecompileRefusal.MissingLocalizationStrings,
                    $"{plugin.Name} is a localized plugin but its strings file '{missing.File}' was not found " +
                    $"loose or in an archive, among the files the game loads or in {modFolder}. Restore the file, then try again."),
                PluginFailure.HeaderFormKeyHeld or PluginFailure.NullFormIdHeld => Decompiled.Refused(DecompileRefusal.RoundTripFailed,
                    $"{plugin.Name} cannot become source: {failure.Reason}."),
                PluginFailure.Inaccessible => Decompiled.Refused(DecompileRefusal.RoundTripFailed,
                    $"{plugin.Name} cannot be read from its own binary ({failure.Reason}). Close whatever holds the file, then try again."),
                PluginFailure.Unparsed unparsed => Decompiled.Refused(UnparsedRefusal(plugin, unparsed)),
                _ => Decompiled.Refused(DecompileRefusal.RoundTripFailed, NotParsed(plugin, failure)),
            };
        }

        onParsed();
        source = source with { Files = DeletedReferenceBases.Dropped(source.Files, loadOrder.GameRelease, schemaReflector) };
        if (await VerifyRoundTrip(plugin.Name, plugin.Path, source, loadOrder, plugin.Strings, cancel) is { } refusal)
            return Decompiled.Refused(refusal);

        return new Decompiled(source, DecompileRefusal.None, "");
    }

    private static string NotParsed(RegisteredPlugin plugin, PluginFailure failure) =>
        $"{plugin.Name} could not be parsed from its own binary: {failure.Reason}";

    private RoundTripRefusal UnparsedRefusal(RegisteredPlugin plugin, PluginFailure.Unparsed unparsed)
    {
        if (unparsed.Malformations is null)
            return new RoundTripRefusal(NotParsed(plugin, unparsed));
        if (!unparsed.Malformations.Holds(out var scan, out var scanFailure))
        {
            logger.LogWarning(scanFailure.Error, "Could not check {Plugin} for malformations: {Reason}", plugin.Name, scanFailure.Reason);
            return new RoundTripRefusal($"{NotParsed(plugin, unparsed)} (it could not be checked for malformations: {scanFailure.Reason})");
        }
        if (scan.AtFailure.Count > 0)
        {
            return new RoundTripRefusal(
                $"{plugin.Name} is a malformed plugin and cannot become source: {Described(scan.AtFailure)}.",
                RepairClears(scan.AtFailure));
        }

        var elsewhere = scan.Elsewhere.Count == 0
            ? ""
            : $" It also holds malformed records: {Described(scan.Elsewhere)}.";
        if (unparsed.Diagnosis.Tail is null)
            return new RoundTripRefusal(NotParsed(plugin, unparsed) + elsewhere);
        return new RoundTripRefusal(scan.Elsewhere.Count == 0
            ? $"{plugin.Name} is a correct plugin that Mutagen mishandles: {unparsed.Reason}"
            : $"Mutagen mishandles {plugin.Name}: {unparsed.Reason}.{elsewhere}");
    }

    private static string Described(IEnumerable<RepairPreview> malformations) =>
        string.Join("; ", malformations.Select(malformation => malformation.Diagnosis.Describe()));

    private static bool RepairClears(IReadOnlyList<RepairPreview> malformations) =>
        malformations.All(malformation => malformation.Change is not null);

    // ADR-0006's gate. Reparse, not the pre-write object: only written bytes show what
    // the writer does.
    private async Task<RoundTripRefusal?> VerifyRoundTrip(
        string pluginName,
        string originalPluginPath,
        PluginSource source,
        LoadOrderSnapshot loadOrder,
        PluginStrings strings,
        CancellationToken cancel)
    {
        var gameRelease = loadOrder.GameRelease;
        using var scratch = ScratchPlugin.For(pluginName);
        if (!(await adapter.WriteFromTreeAsync(
                    sourceAdapter.ReadBackOf(pluginName, source.Files, gameRelease), scratch.PluginPath, source.Masters, loadOrder, cancel))
                .Holds(out var recompiledPath, out var failure)
            || !(await adapter.CompareBytesAsync(originalPluginPath, recompiledPath, loadOrder, cancel)).Holds(out var comparison, out failure))
        {
            logger.LogWarning(failure.Error, "Refused to decompile {Plugin}: {Reason}", pluginName, failure.Reason);
            return new RoundTripRefusal($"{pluginName} does not round-trip through its own source: {failure.Reason}");
        }

        if (comparison.Identical)
            return null;

        if (comparison.DeletedRecordCauses is { } deleted)
        {
            return new RoundTripRefusal(
                $"{pluginName} does not round-trip through its own source: it is a malformed plugin, and {Described(deleted)}.",
                RepairClears(deleted));
        }

        if (comparison.Loss is { } loss)
        {
            // A Kind B diagnosis on the record names the cause ahead of the drop it produced.
            return comparison.LossCauses is { } causes
                ? new RoundTripRefusal(
                    $"{pluginName} does not round-trip through its own source: it is a malformed plugin, and {Described(causes)} — " +
                    $"parsing the malformed subrecord dropped {string.Join(", ", loss.Signatures)} before its source was written.",
                    RepairClears(causes))
                : new RoundTripRefusal(
                    $"{pluginName} does not round-trip through its own source: {loss.RecordType} {loss.FormKey} is missing {string.Join(", ", loss.Signatures)} " +
                    "present in the original — dropped during parsing, before its source was written.");
        }

        if (comparison.Unverified is { } unverified)
        {
            var state = unverified.Reason == UnverifiedReason.AbsentFromRewrite
                ? "is absent from the rewrite"
                : "could not be compared with its rewrite";
            return new RoundTripRefusal(
                $"{pluginName} does not round-trip through its own source: {unverified.RecordType} {unverified.FormKey} {state}, " +
                "so its records cannot be proven intact.");
        }

        // Both are reparsed, so only bytes that differ pay for it.
        if (!adapter.DivergenceFrom(pluginName, originalPluginPath, recompiledPath, loadOrder, strings)
                .Holds(out var divergence, out failure))
        {
            return new RoundTripRefusal($"{pluginName} does not round-trip through its own source: {failure.Reason}");
        }
        if (divergence is not null)
        {
            return divergence.Causes is { } causes
                ? new RoundTripRefusal(
                    $"{pluginName} does not round-trip through its own source: it is a malformed plugin, and {Described(causes)} — {divergence.Description}",
                    RepairClears(causes))
                : new RoundTripRefusal($"{pluginName} does not round-trip through its own source: {divergence.Description}");
        }

        // An encoding-only difference (ADR-0006) is reported, never a refusal.
        if (logger.IsEnabled(LogLevel.Information))
        {
            logger.LogInformation(
                "{Plugin} is model-identical to its own source but not byte-identical — " +
                "Save & Compile will not reproduce this plugin's exact bytes (ADR-0006).",
                pluginName);
        }

        return null;
    }
}
