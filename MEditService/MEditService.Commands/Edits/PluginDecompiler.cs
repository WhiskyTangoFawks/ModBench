using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Commands.Edits;

/// <summary>A plugin's bytes as the whole-mod door's tree of its plugin source, or why they cannot be: ADR-0006's
/// gate refused it, or it cannot be read. Writes nothing.</summary>
internal sealed record Decompiled(PluginSource? Source, DecompileRefusal Refusal, string Message)
{
    internal static Decompiled Refused(DecompileRefusal refusal, string message) => new(null, refusal, message);
}

/// <summary>Track and decompile both read a plugin into its plugin source through this one gate.
/// </summary>
internal sealed class PluginDecompiler(ILogger logger, IPluginAdapter adapter, ISourceAdapter sourceAdapter)
{
    internal async Task<Decompiled> DecompileAsync(
        LoadOrderSnapshot loadOrder, RegisteredPlugin plugin, string modFolder, Action onParsed, CancellationToken cancel)
    {
        // Naming where the strings are: "pass nothing" is not neutral for a Localized plugin.
        var strings = new PluginStrings(modFolder, loadOrder.DataFolderPath);

        // A fresh deep parse, not the load order's own overlay, whose lifetime this gate does not control.
        if (!(await adapter.ReadSourceOfAsync(plugin, loadOrder.GameRelease, strings, cancel)).Holds(out var source, out var failure))
        {
            logger.LogWarning(failure.Error, "Refused to decompile {Plugin}: {Reason}", plugin.Name, failure.Reason);
            return failure switch
            {
                PluginFailure.MissingStrings missing => Decompiled.Refused(DecompileRefusal.MissingLocalizationStrings,
                    $"{plugin.Name} is a localized plugin but its strings file '{missing.File}' was not found " +
                    $"in {strings.Folder}. Restore the file, then try again."),
                PluginFailure.Inaccessible => Decompiled.Refused(DecompileRefusal.RoundTripFailed,
                    $"{plugin.Name} cannot be read from its own binary ({failure.Reason}). Close whatever holds the file, then try again."),
                _ => Decompiled.Refused(DecompileRefusal.RoundTripFailed,
                    $"{plugin.Name} could not be parsed from its own binary: {failure.Reason}"),
            };
        }

        onParsed();
        if (await VerifyRoundTrip(plugin.Name, plugin.Path, source, loadOrder.GameRelease, strings, cancel) is { } refusal)
            return Decompiled.Refused(DecompileRefusal.RoundTripFailed, refusal);

        return new Decompiled(source, DecompileRefusal.None, "");
    }

    // ADR-0006's gate. Reparse, not the pre-write object: only written bytes show what
    // the writer does.
    private async Task<string?> VerifyRoundTrip(
        string pluginName,
        string originalPluginPath,
        PluginSource source,
        GameRelease gameRelease,
        PluginStrings strings,
        CancellationToken cancel)
    {
        using var scratch = ScratchPlugin.For(pluginName);
        if (!(await adapter.WriteFromTreeAsync(
                    sourceAdapter.ReadBackOf(pluginName, source.Files, gameRelease), scratch.PluginPath, source.Masters, cancel))
                .Holds(out var recompiledPath, out var failure)
            || !(await adapter.CompareBytesAsync(originalPluginPath, recompiledPath, cancel)).Holds(out var comparison, out failure))
        {
            logger.LogWarning(failure.Error, "Refused to decompile {Plugin}: {Reason}", pluginName, failure.Reason);
            return $"{pluginName} does not round-trip through its own source: {failure.Reason}";
        }

        if (comparison.Identical)
            return null;

        if (comparison.Loss is { } loss)
        {
            // A Kind B diagnosis on the record names the cause ahead of the drop it produced.
            return $"{pluginName} does not round-trip through its own source: " + (comparison.LossCause is { } cause
                ? $"{cause.Describe()} — parsing the malformed subrecord dropped " +
                  $"{string.Join(", ", loss.Signatures)} before its source was written."
                : $"{loss.RecordType} {loss.FormId:X8} is missing {string.Join(", ", loss.Signatures)} " +
                  "present in the original — dropped during parsing, before its source was written.");
        }

        // Both are reparsed, so only bytes that differ pay for it.
        if (!adapter.DivergenceFrom(pluginName, originalPluginPath, recompiledPath, gameRelease, strings)
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
