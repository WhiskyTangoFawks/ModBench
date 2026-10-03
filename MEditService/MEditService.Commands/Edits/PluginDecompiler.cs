using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Commands.Edits;

/// <summary>A plugin's bytes as the files of its plugin source, or why they cannot be: ADR-0006's
/// gate refused it, or it cannot be read. Writes nothing.</summary>
internal sealed record Decompiled(IReadOnlyList<TreeFile>? Files, DecompileRefusal Refusal, string Message)
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
        (IReadOnlyList<TreeFile> Files, string? MissingStringsFile) tree;
        try
        {
            tree = await adapter.ReadSourceOfAsync(plugin, loadOrder.GameRelease, strings, cancel);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            // A raw parse exception's Message carries no located identity; the diagnosis walks the tree for
            // the innermost RecordException.
            var diagnosis = PluginDiagnosis.FromParseException(ex);
            logger.LogWarning(ex, "Refused to decompile {Plugin}: its own binary could not be deep-parsed", plugin.Name);
            return Decompiled.Refused(DecompileRefusal.RoundTripFailed,
                $"{plugin.Name} could not be parsed from its own binary: {diagnosis.Describe()}");
        }

        if (tree.MissingStringsFile is { } missingFile)
        {
            return Decompiled.Refused(DecompileRefusal.MissingLocalizationStrings,
                $"{plugin.Name} is a localized plugin but its strings file '{missingFile}' was not found " +
                $"in {strings.Folder}. Restore the file, then try again.");
        }

        // Where the door's tree lands in the mod folder is the repository's answer, and the round-trip
        // gate below reads the same files the caller writes.
        onParsed();
        var files = SourceRepository.PristineFilesOf(plugin.Name, tree.Files);
        if (await VerifyRoundTrip(plugin.Name, plugin.Path, files, loadOrder.GameRelease, strings, cancel) is { } refusal)
            return Decompiled.Refused(DecompileRefusal.RoundTripFailed, refusal);

        return new Decompiled(files, DecompileRefusal.None, "");
    }

    // ADR-0006's gate. Reparse, not the pre-write object: only written bytes show what
    // the writer does.
    private async Task<string?> VerifyRoundTrip(
        string pluginName,
        string originalPluginPath,
        IReadOnlyList<TreeFile> pristineFilesForThisPlugin,
        GameRelease gameRelease,
        PluginStrings strings,
        CancellationToken cancel)
    {
        using var scratch = SourceRepository.ScratchFor(pluginName);
        var recompiledPath = scratch.PluginPath;
        try
        {
            await adapter.WriteFromTreeAsync(pristineFilesForThisPlugin, recompiledPath, cancel);
        }
        catch (Exception ex) when (PluginDiagnosis.HasUnmappableFormID(ex))
        {
            // ADR-0008's content-derived master pass prunes a master this write still needs when the only
            // reference lives in a VMAD struct-list property Mutagen never walks (upstream issue 688). Never
            // widen this catch.
            var diagnosis = PluginDiagnosis.FromWriteException(ex);
            logger.LogWarning(ex, "Refused to decompile {Plugin}: its round-trip write dropped a needed master", pluginName);
            return $"{pluginName} does not round-trip through its own source: {diagnosis.Describe()}";
        }

        var originalBytes = await PluginBinaryHash.ExactBytesOfFileAsync(originalPluginPath, cancel);
        var recompiledBytes = await PluginBinaryHash.ExactBytesOfFileAsync(recompiledPath, cancel);
        if (originalBytes.AsSpan().SequenceEqual(recompiledBytes))
            return null;

        if (PluginBinaryWalk.FindFirstSubrecordLoss(originalBytes, recompiledBytes) is { } loss)
        {
            // A Kind B diagnosis on the record names the cause ahead of the drop it produced.
            var kindB = MalformedPluginScan.Scan(originalBytes).FirstOrDefault(d =>
                d.Anchor?.StartsWith($"{loss.RecordType} {loss.FormId:X8}", StringComparison.Ordinal) == true);
            return $"{pluginName} does not round-trip through its own source: " + (kindB != null
                ? $"{kindB.Describe()} — parsing the malformed subrecord dropped " +
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
