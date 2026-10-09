using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Commands.Edits;

/// <summary>A plugin's bytes as the whole-mod door's tree of its plugin source, or why they cannot be: ADR-0006's
/// gate refused it, or it cannot be read. Writes nothing.</summary>
internal sealed record Decompiled(PluginSourceRead.Read? Source, DecompileRefusal Refusal, string Message)
{
    internal static Decompiled Refused(DecompileRefusal refusal, string message) => new(null, refusal, message);
}

/// <summary>Track and decompile both read a plugin into its plugin source through this one gate.
/// </summary>
internal sealed class PluginDecompiler(ILogger logger, IPluginAdapter adapter)
{
    // Asked of the Plugin adapter (ADR-0015): a plugin whose file
    // cannot be read has no bytes to deep-parse.
    internal async Task<Decompiled> DecompileAsync(
        LoadOrderSnapshot loadOrder, RegisteredPlugin plugin, string modFolder, Action onParsed, CancellationToken cancel)
    {
        if (!adapter.CanRead(plugin))
        {
            return Decompiled.Refused(DecompileRefusal.RoundTripFailed,
                $"{plugin.Name} cannot be read from its own binary. Close whatever holds the file, then try again.");
        }

        // Naming where the strings are: "pass nothing" is not neutral for a Localized plugin.
        var strings = new PluginStrings(modFolder, loadOrder.DataFolderPath);

        // A fresh deep parse, not the load order's own overlay, whose lifetime this gate does not control.
        var read = await adapter.ReadSourceOfAsync(plugin, loadOrder.GameRelease, strings, cancel);
        if (read is PluginSourceRead.Unparsed unparsed)
        {
            logger.LogWarning(unparsed.Error, "Refused to decompile {Plugin}: its own binary could not be deep-parsed", plugin.Name);
            return Decompiled.Refused(DecompileRefusal.RoundTripFailed,
                $"{plugin.Name} could not be parsed from its own binary: {unparsed.Diagnosis.Describe()}");
        }

        if (read is PluginSourceRead.MissingStrings missing)
        {
            return Decompiled.Refused(DecompileRefusal.MissingLocalizationStrings,
                $"{plugin.Name} is a localized plugin but its strings file '{missing.File}' was not found " +
                $"in {strings.Folder}. Restore the file, then try again.");
        }

        var source = (PluginSourceRead.Read)read;
        onParsed();
        if (await VerifyRoundTrip(plugin.Name, plugin.Path, source.Files, loadOrder.GameRelease, strings, cancel) is { } refusal)
            return Decompiled.Refused(DecompileRefusal.RoundTripFailed, refusal);

        return new Decompiled(source, DecompileRefusal.None, "");
    }

    // ADR-0006's gate. Reparse, not the pre-write object: only written bytes show what
    // the writer does.
    private async Task<string?> VerifyRoundTrip(
        string pluginName,
        string originalPluginPath,
        IReadOnlyList<TreeFile> tree,
        GameRelease gameRelease,
        PluginStrings strings,
        CancellationToken cancel)
    {
        using var scratch = ScratchPlugin.For(pluginName);
        var recompiledPath = scratch.PluginPath;
        var originalMasters = adapter.MastersOf(pluginName, originalPluginPath, gameRelease, strings);
        if (await adapter.WriteFromTreeAsync(
                SourceRepository.ReadBackOf(pluginName, tree, gameRelease), recompiledPath, originalMasters, cancel)
            is { } unmappable)
        {
            var described = unmappable.Describe();
            logger.LogWarning("Refused to decompile {Plugin}: its round-trip write dropped a needed master: {Diagnosis}", pluginName, described);
            return $"{pluginName} does not round-trip through its own source: {described}";
        }

        var comparison = await adapter.CompareBytesAsync(originalPluginPath, recompiledPath, cancel);
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

        if (adapter.DivergenceFrom(
                pluginName, originalPluginPath, recompiledPath, gameRelease, strings) is { } divergence)
        {
            return $"{pluginName} does not round-trip through its own source: {divergence}";
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
