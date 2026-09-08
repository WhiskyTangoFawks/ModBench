using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Source;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Commands;

/// <summary>ADR-0041's create gesture: the plugin file, a registered copy at once, and the Track its
/// destination needs before anything can be edited there. Never touches plugins.txt.</summary>
public sealed class CreatePluginHandler
{
    private readonly LoadOrderHolder _loadOrder;
    private readonly TrackHandler _track;

    // Internal so only CommandHandlers.AddCommandHandlers builds one, like every other handler.
    internal CreatePluginHandler(LoadOrderHolder loadOrder, TrackHandler track)
    {
        _loadOrder = loadOrder;
        _track = track;
    }

    /// <summary>Asynchronous because Track is: the destination is tracked in this same gesture, so a
    /// created plugin is editable the moment it exists.</summary>
    public async Task<PluginCreateResult> CreatePlugin(
        IReadOnlyCollection<PluginKey> heldCopies, string name, string path, string origin)
    {
        var extension = ValidatedExtension(name, path, origin);

        var loadOrder = _loadOrder.Current;
        if (string.IsNullOrEmpty(loadOrder.DataFolderPath)) throw new NoLoadOrderException();

        // Never-assume-exclusive-ownership: the destination may be a mod folder nothing has written
        // into yet — a brand-new mod, or overwrite/ before its first file.
        Directory.CreateDirectory(path);
        var filePath = Path.Combine(path, name);
        if (File.Exists(filePath))
            throw new IOException($"Plugin file already exists: {name}");

        var mod = ModFactory.Activator(ModKey.FromFileName(name), loadOrder.GameRelease);
        // A new plugin defaults to an ESL-flagged ESP, silently; the flag is an ordinary editable
        // header field afterward. An explicit .esl is already light, an explicit .esm asked for a
        // full master.
        if (extension.Equals(".esp", StringComparison.OrdinalIgnoreCase)) mod.IsSmallMaster = true;
        mod.WriteToBinary(filePath);

        // ADR-0041: a participant at once, so Track below and every later reader see it without
        // waiting for the snapshot that appends its plugins.txt line.
        var copy = new RegisteredCopy(name, origin, filePath, NextSlot(loadOrder), Enabled: true, Winning: true);
        _loadOrder.Register(copy);

        if (SourceRepository.IsTracked(path)) return new PluginCreateResult(copy, null);

        // Held by construction: this gesture wrote the file, so Track's own "which copies are
        // readable" filter must count it alongside whatever the Index already holds.
        var track = await _track.TrackAsync(
            _loadOrder.Current, [.. heldCopies, copy.Key], origin, SourcePreset.Edits);
        return new PluginCreateResult(copy, track);
    }

    private static string ValidatedExtension(string name, string path, string origin)
    {
        if (string.IsNullOrWhiteSpace(name))
            throw new ArgumentException("Plugin name cannot be empty.", nameof(name));
        if (string.IsNullOrWhiteSpace(path))
            throw new ArgumentException("Destination path cannot be empty.", nameof(path));
        if (string.IsNullOrWhiteSpace(origin))
            throw new ArgumentException("Origin cannot be empty.", nameof(origin));

        var extension = Path.GetExtension(name);
        if (!extension.Equals(".esp", StringComparison.OrdinalIgnoreCase) &&
            !extension.Equals(".esm", StringComparison.OrdinalIgnoreCase) &&
            !extension.Equals(".esl", StringComparison.OrdinalIgnoreCase))
        {
            throw new ArgumentException($"Invalid plugin extension '{extension}'. Must be .esp, .esm, or .esl.", nameof(name));
        }
        return extension;
    }

    // One past the highest slot, not the count: a reused slot would give two participants one index.
    private static int NextSlot(LoadOrder loadOrder) =>
        loadOrder.Copies.Count == 0 ? 0 : loadOrder.Copies.Max(copy => copy.Slot ?? 0) + 1;
}
