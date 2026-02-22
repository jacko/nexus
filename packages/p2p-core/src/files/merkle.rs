use serde::{Deserialize, Serialize};

/// A 32-byte BLAKE3 hash.
pub type Hash = [u8; 32];

/// A binary Merkle tree built from BLAKE3 chunk hashes.
///
/// Stored as a flat vector in level order (leaves first, root last).
/// For an odd number of nodes at any level, the last node is duplicated.
#[derive(Debug, Clone)]
pub struct MerkleTree {
    /// All nodes in level order. `nodes[nodes.len() - 1]` is the root.
    nodes: Vec<Hash>,
    /// Number of original leaves.
    leaf_count: usize,
}

/// A proof that a chunk (leaf) belongs to the Merkle tree.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MerkleProof {
    /// Index of the leaf in the original leaf array.
    pub leaf_index: u32,
    /// Sibling hashes from leaf to root. Each entry is (hash, is_right_sibling).
    pub siblings: Vec<(Hash, bool)>,
}

impl MerkleTree {
    /// Build a Merkle tree from a list of chunk hashes (BLAKE3 hashes of each chunk).
    ///
    /// Interior nodes are computed as `blake3(left || right)`.
    /// If a level has an odd number of nodes, the last node is duplicated.
    pub fn from_leaves(leaves: Vec<Hash>) -> Self {
        assert!(!leaves.is_empty(), "cannot build tree from zero leaves");

        let leaf_count = leaves.len();
        let mut nodes = Vec::new();

        // Add leaves as the first level
        let mut current_level = leaves;

        loop {
            nodes.extend_from_slice(&current_level);

            if current_level.len() == 1 {
                break;
            }

            // Pad odd level
            if current_level.len() % 2 != 0 {
                let last = *current_level.last().unwrap();
                current_level.push(last);
            }

            // Build parent level
            let mut parents = Vec::with_capacity(current_level.len() / 2);
            for pair in current_level.chunks(2) {
                let mut combined = [0u8; 64];
                combined[..32].copy_from_slice(&pair[0]);
                combined[32..].copy_from_slice(&pair[1]);
                parents.push(*blake3::hash(&combined).as_bytes());
            }

            current_level = parents;
        }

        Self { nodes, leaf_count }
    }

    /// The root hash of the tree.
    pub fn root(&self) -> Hash {
        *self.nodes.last().expect("tree is not empty")
    }

    /// Get all leaf hashes (chunk hashes) from the tree.
    pub fn leaf_hashes(&self) -> &[Hash] {
        &self.nodes[..self.leaf_count]
    }

    /// Generate a Merkle proof for the leaf at `index`.
    pub fn proof(&self, index: usize) -> MerkleProof {
        assert!(index < self.leaf_count, "leaf index out of range");

        let mut siblings = Vec::new();
        let mut level_start = 0;
        let mut level_len = self.leaf_count;
        let mut pos = index;

        loop {
            // Compute padded length for this level
            let padded_len = if level_len % 2 != 0 && level_len > 1 {
                level_len + 1
            } else {
                level_len
            };

            if padded_len <= 1 {
                break;
            }

            // Find sibling
            let sibling_pos = if pos % 2 == 0 { pos + 1 } else { pos - 1 };
            let is_right = pos % 2 == 0; // sibling is on the right if we're on the left

            let sibling_hash = if sibling_pos < level_len {
                self.nodes[level_start + sibling_pos]
            } else {
                // Padded duplicate — sibling is a copy of the last node
                self.nodes[level_start + level_len - 1]
            };

            siblings.push((sibling_hash, is_right));

            // Move to parent level
            level_start += level_len;
            level_len = padded_len / 2;
            pos /= 2;
        }

        MerkleProof {
            leaf_index: index as u32,
            siblings,
        }
    }

    /// Verify that a chunk hash at the given index produces the expected root.
    pub fn verify(root: &Hash, chunk_hash: &Hash, proof: &MerkleProof) -> bool {
        let mut current = *chunk_hash;

        for (sibling, is_right) in &proof.siblings {
            let mut combined = [0u8; 64];
            if *is_right {
                // We are left, sibling is right
                combined[..32].copy_from_slice(&current);
                combined[32..].copy_from_slice(sibling);
            } else {
                // Sibling is left, we are right
                combined[..32].copy_from_slice(sibling);
                combined[32..].copy_from_slice(&current);
            }
            current = *blake3::hash(&combined).as_bytes();
        }

        current == *root
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_leaf() {
        let leaf = *blake3::hash(b"hello").as_bytes();
        let tree = MerkleTree::from_leaves(vec![leaf]);
        assert_eq!(tree.root(), leaf);
        let proof = tree.proof(0);
        assert!(MerkleTree::verify(&tree.root(), &leaf, &proof));
    }

    #[test]
    fn two_leaves() {
        let a = *blake3::hash(b"chunk0").as_bytes();
        let b = *blake3::hash(b"chunk1").as_bytes();
        let tree = MerkleTree::from_leaves(vec![a, b]);

        let proof_a = tree.proof(0);
        assert!(MerkleTree::verify(&tree.root(), &a, &proof_a));

        let proof_b = tree.proof(1);
        assert!(MerkleTree::verify(&tree.root(), &b, &proof_b));

        // Wrong hash should fail
        let wrong = *blake3::hash(b"wrong").as_bytes();
        assert!(!MerkleTree::verify(&tree.root(), &wrong, &proof_a));
    }

    #[test]
    fn odd_leaves() {
        let leaves: Vec<Hash> = (0..5u8)
            .map(|i| *blake3::hash(&[i]).as_bytes())
            .collect();
        let tree = MerkleTree::from_leaves(leaves.clone());

        for (i, leaf) in leaves.iter().enumerate() {
            let proof = tree.proof(i);
            assert!(
                MerkleTree::verify(&tree.root(), leaf, &proof),
                "proof failed for leaf {i}"
            );
        }
    }

    #[test]
    fn many_leaves() {
        let leaves: Vec<Hash> = (0..100u32)
            .map(|i| *blake3::hash(&i.to_le_bytes()).as_bytes())
            .collect();
        let tree = MerkleTree::from_leaves(leaves.clone());

        for (i, leaf) in leaves.iter().enumerate() {
            let proof = tree.proof(i);
            assert!(
                MerkleTree::verify(&tree.root(), leaf, &proof),
                "proof failed for leaf {i}"
            );
        }
    }
}
