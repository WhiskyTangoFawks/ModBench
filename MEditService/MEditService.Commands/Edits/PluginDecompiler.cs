using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Commands.Edits;

/// <summary>A plugin's bytes as the whole-mod door's tree of its plugin source, or why they cannot be: ADR-0006's
/// gate refused it, or it cannot be read. Writes nothing.</summary>
internal sealed record Decompiled(PluginSource? Source, DecompileRefusal Refusal, string Message)
{
    internal static Decompiled Refused(DecompileRefusal refusal, string message) => new(null, refusal, message);
}

/// <summary>Init and decompile both read a plugin into its plugin source through this one gate.
/// </summary>
internal sealed class PluginDecompiler(ILogger logger, IPluginAdapter adapter, ISourceAdapter sourceAdapter)
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
                _ => Decompiled.Refused(DecompileRefusal.RoundTripFailed,
                    $"{plugin.Name} could not be parsed from its own binary: {failure.Reason}"),
            };
        }

        onParsed();
        if (await VerifyRoundTrip(plugin.Name, plugin.Path, source, loadOrder, plugin.Strings, cancel) is { } refusal)
            return Decompiled.Refused(DecompileRefusal.RoundTripFailed, refusal);

        return new Decompiled(source, DecompileRefusal.None, "");
    }

    // ADR-0006's gate. Reparse, not the pre-write object: only written bytes show what
    // the writer does.
    private async Task<string?> VerifyRoundTrip(
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
            return $"{pluginName} does not round-trip through its own source: {failure.Reason}";
        }

        if (comparison.Identical)
            return null;

        if (comparison.DeletedRecordEmptied is { } deleted)
        {
            return $"{pluginName} does not round-trip through its own source: {deleted} is flagged Deleted and still " +
                   "holds fields, which Mutagen does not write for a deleted record.";
        }

        if (comparison.Loss is { } loss)
        {
            // A Kind B diagnosis on the record names the cause ahead of the drop it produced.
            return $"{pluginName} does not round-trip through its own source: " + (comparison.LossCause is { } cause
                ? $"{cause.Describe()} — parsing the malformed subrecord dropped " +
                  $"{string.Join(", ", loss.Signatures)} before its source was written."
                : $"{loss.RecordType} {loss.FormKey} is missing {string.Join(", ", loss.Signatures)} " +
                  "present in the original — dropped during parsing, before its source was written.");
        }

        // Both are reparsed, so only bytes that differ pay for it.
        if (!adapter.DivergenceFrom(pluginName, originalPluginPath, recompiledPath, loadOrder, strings)
                .Holds(out var divergence, out failure))
        {
            divergence = failure.Reason;
        }
        if (divergence is not null)
            return $"{pluginName} does not round-trip through its own source: {divergence}";

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
